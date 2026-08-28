import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasEffectivePairedDeviceRole,
  listDevicePairing,
  type PairedDevice,
} from "../infra/device-pairing.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  isWebPushQuietHours,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  listBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";

const OPERATOR_ROLE = "operator";
const EVENT_PUSH_TTL_SECONDS = 5 * 60;

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
};

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // SAFETY: the runtime object and array guards establish a string-keyed record.
  return value as Record<string, unknown>;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

export function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = record(payload);
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = safeLabel(value.id) ?? "pending";
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
    };
  }
  if (event === "chat" && value.state === "final") {
    const runId = safeLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
      tag: `openclaw-agent-finished-${runId}`,
    };
  }
  if (event === "task" && value.action === "upserted") {
    const task = record(value.task);
    if (task?.status !== "failed" && task?.status !== "timed_out") {
      return null;
    }
    const taskId = safeLabel(task.id) ?? "failed";
    const taskTitle = safeLabel(task.title);
    return {
      category: "background-task-failed",
      title: "OpenClaw background task failed",
      body: "A background task needs attention.",
      ...(taskTitle ? { identifiedBody: `${taskTitle} needs attention.` } : {}),
      tag: `openclaw-task-failed-${taskId}`,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = record(value.job);
    const jobId = safeLabel(value.jobId) ?? "failed";
    const jobName = safeLabel(job?.name);
    return {
      category: "scheduled-task-failed",
      title: "OpenClaw scheduled task failed",
      body: "A scheduled task needs attention.",
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobId}`,
    };
  }
  return null;
}

function currentTarget(params: {
  subscription: BoundWebPushSubscription;
  device: PairedDevice | undefined;
  cfg: OpenClawConfig;
}): { scopes: string[]; profileId: string | null } | null {
  const { subscription, device, cfg } = params;
  if (!device || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
    return null;
  }
  const token = device.tokens?.[OPERATOR_ROLE];
  const approvedScopes = device.approvedScopes ?? device.scopes;
  if (
    !token ||
    token.revokedAtMs ||
    !approvedScopes ||
    !roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes: token.scopes,
      allowedScopes: approvedScopes,
    })
  ) {
    return null;
  }
  const storedProfileId = subscription.userProfileId;
  const profileId = storedProfileId ? (resolveUserProfileId(storedProfileId) ?? null) : null;
  if ((storedProfileId && !profileId) || (cfg.gateway?.roles && !profileId)) {
    return null;
  }
  const rolePolicy = profileId ? resolveOperatorRolePolicyForProfile(profileId, cfg) : undefined;
  const allowed = rolePolicy ? new Set<string>(rolePolicy.scopes) : null;
  const scopes = allowed ? token.scopes.filter((scope) => allowed.has(scope)) : [...token.scopes];
  return scopes.includes(READ_SCOPE) ? { scopes, profileId } : null;
}

function projectedClient(params: {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  profileId: string | null;
}): GatewayWsClient {
  // SAFETY: session visibility reads only connect and authenticated profile fields from this projection.
  const client = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "event-web-push",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      device: {
        id: params.subscription.deviceId,
        publicKey: "event-web-push",
        signature: "event-web-push",
        signedAt: 0,
        nonce: "event-web-push",
      },
      role: OPERATOR_ROLE,
      scopes: params.scopes,
    },
    ...(params.profileId
      ? {
          authenticatedUserProfile: {
            profileId: params.profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        }
      : {}),
  };
  // SAFETY: session visibility reads only connect and authenticated profile fields from this projection.
  return client as GatewayWsClient;
}

function preferenceFor(subscription: BoundWebPushSubscription, stateDir?: string) {
  const profileId = subscription.userProfileId
    ? resolveUserProfileId(subscription.userProfileId)
    : undefined;
  const user = profileId
    ? getUserPreferences(
        profileId,
        [WEB_PUSH_USER_PREFERENCES_KEY],
        stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {},
      )[WEB_PUSH_USER_PREFERENCES_KEY]
    : undefined;
  return resolveEffectiveWebPushPreferences({ user, device: subscription.devicePreferences });
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
  stateDir?: string;
}) {
  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (!notification) {
        return;
      }
      void (async () => {
        const cfg = params.getRuntimeConfig();
        const subscriptions = listBoundWebPushSubscriptions(params.stateDir);
        if (subscriptions.length === 0) {
          return;
        }
        const sender = await prepareWebPushNotificationSender(params.stateDir);
        const pairing = await listDevicePairing();
        const paired = new Map(pairing.paired.map((device) => [device.deviceId, device]));
        const agentId = normalizeOptionalString(opts?.agentId ?? record(payload)?.agentId);
        const groups = new Map<
          string,
          { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
        >();
        for (const subscription of subscriptions) {
          const target = currentTarget({
            subscription,
            device: paired.get(subscription.deviceId),
            cfg,
          });
          if (!target) {
            continue;
          }
          if (
            notification.category === "agent-question" &&
            !target.scopes.includes(QUESTIONS_SCOPE)
          ) {
            continue;
          }
          const preferences = preferenceFor(subscription, params.stateDir);
          if (
            !webPushCategoryEnabled(preferences, notification.category) ||
            isWebPushQuietHours(preferences) ||
            !webPushAgentAllowed(preferences, agentId)
          ) {
            continue;
          }
          const sessionKeys = opts?.sessionKeys ?? [];
          if (
            sessionKeys.length > 0 &&
            !canReceiveSessionEvent({
              cfg,
              client: projectedClient({
                subscription,
                scopes: target.scopes,
                profileId: target.profileId,
              }),
              sessionKeys,
              ...(agentId ? { agentId } : {}),
              event,
              payload,
            })
          ) {
            continue;
          }
          if (cfg.gateway?.roles && sessionKeys.length === 0) {
            // Multi-user events without an authoritative session owner are not broadcast offline.
            continue;
          }
          const prefix = preferences.label ? `${preferences.label} · ` : "";
          const title = `${prefix}${notification.title}`;
          const body =
            preferences.detailLevel === "private"
              ? notification.body
              : (notification.identifiedBody ??
                (agentId ? `${agentId}: ${notification.body}` : notification.body));
          const key = JSON.stringify({ title, body });
          const group = groups.get(key) ?? { title, body, subscriptions: [] };
          group.subscriptions.push(subscription);
          groups.set(key, group);
        }
        const topic = createHash("sha256")
          .update(notification.tag)
          .digest("base64url")
          .slice(0, 32);
        await Promise.all(
          [...groups.values()].map((group) =>
            sender({
              subscriptions: group.subscriptions,
              payload: {
                title: group.title,
                body: group.body,
                tag: notification.tag,
                renotify: false,
              },
              deliveryOptions: {
                TTL: EVENT_PUSH_TTL_SECONDS,
                urgency: notification.category.includes("failed") ? "high" : "normal",
                topic,
              },
            }),
          ),
        );
      })().catch((error: unknown) => {
        params.log?.warn?.(`event Web Push delivery failed event=${event}: ${String(error)}`);
      });
    },
  };
}
