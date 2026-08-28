import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
// Application-owned browser push subscription lifecycle.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { WebPushPreferencesResult } from "./web-push.runtime.ts";

type WebPushSnapshot = {
  supported: boolean;
  unsupportedReason: "ios-install-required" | "browser-unsupported" | null;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error: string | null;
  preferences: WebPushPreferencesResult | null;
};

export type WebPushCapability = {
  readonly snapshot: WebPushSnapshot;
  subscribe: (listener: (snapshot: WebPushSnapshot) => void) => () => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTest: () => Promise<void>;
  setUserPreferences: (preferences: WebPushNotificationPreferences) => Promise<void>;
  setDevicePreferences: (preferences: WebPushDevicePreferences) => Promise<void>;
  dispose: () => void;
};

function isIosStandalone(nav: Navigator): boolean {
  // SAFETY: iOS Safari's non-standard standalone flag is optional and read-only.
  return Boolean((nav as Navigator & { standalone?: boolean }).standalone);
}

function isWebPushSupported(): boolean {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const ios = Boolean(nav && /iPad|iPhone|iPod/u.test(nav.userAgent));
  const standalone = Boolean(nav && "standalone" in nav && isIosStandalone(nav));
  if (ios && !standalone) {
    return false;
  }
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function createWebPushCapability(gateway: ApplicationGateway): WebPushCapability {
  const supported = isWebPushSupported();
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const iosInstallRequired = Boolean(
    nav &&
    /iPad|iPhone|iPod/u.test(nav.userAgent) &&
    !("standalone" in nav && isIosStandalone(nav)),
  );
  let snapshot: WebPushSnapshot = {
    supported,
    unsupportedReason: supported
      ? null
      : iosInstallRequired
        ? "ios-install-required"
        : "browser-unsupported",
    permission: supported ? Notification.permission : "unsupported",
    subscribed: false,
    loading: false,
    error: null,
    preferences: null,
  };
  let disposed = false;
  let connectedClient: GatewayBrowserClient | null = null;
  let connectionGeneration = 0;
  let operation: Promise<void> | null = null;
  const listeners = new Set<(snapshot: WebPushSnapshot) => void>();

  const publish = (patch: Partial<WebPushSnapshot>) => {
    if (disposed) {
      return;
    }
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const readExistingSubscription = async () => {
    if (!supported) {
      return null;
    }
    const { getExistingSubscription } = await import("./web-push.runtime.ts");
    const subscription = await getExistingSubscription();
    publish({ subscribed: subscription !== null });
    return subscription;
  };

  const reconcile = async (client: GatewayBrowserClient, generation: number) => {
    try {
      const { reconcileExistingWebPushSubscription } = await import("./web-push.runtime.ts");
      const result = await reconcileExistingWebPushSubscription(client);
      if (
        generation !== connectionGeneration ||
        gateway.snapshot.phase !== "connected" ||
        gateway.snapshot.client !== client
      ) {
        return;
      }
      let preferences: WebPushPreferencesResult | null = null;
      if (result.state === "registered") {
        const { getWebPushPreferences } = await import("./web-push.runtime.ts");
        preferences = await getWebPushPreferences(client);
      }
      publish({
        subscribed: result.state !== "missing",
        preferences,
        error: result.state === "vapid-mismatch" ? result.error : null,
      });
    } catch (error) {
      if (
        generation !== connectionGeneration ||
        gateway.snapshot.phase !== "connected" ||
        gateway.snapshot.client !== client
      ) {
        return;
      }
      // Local subscription presence is independent from this Gateway request.
      // Preserve it so Settings keeps the explicit unsubscribe/recovery action.
      publish({ error: formatUiError(error) });
    }
  };

  const run = (action: (client: GatewayBrowserClient) => Promise<void>) => {
    const client = gateway.snapshot.client;
    if (!supported || !client || operation) {
      return operation ?? Promise.resolve();
    }
    publish({ loading: true, error: null });
    operation = action(client)
      .catch((error: unknown) => {
        publish({ error: formatUiError(error) });
      })
      .finally(() => {
        operation = null;
        publish({
          loading: false,
          permission: "Notification" in window ? Notification.permission : "unsupported",
        });
      });
    return operation;
  };

  void readExistingSubscription().catch(() => {});
  const stopGateway = gateway.subscribe((gatewaySnapshot) => {
    const client = gatewaySnapshot.client;
    const connected = gatewaySnapshot.phase === "connected" && client !== null;
    const nextClient = connected ? client : null;
    if (nextClient === connectedClient) {
      return;
    }
    connectedClient = nextClient;
    const generation = ++connectionGeneration;
    if (nextClient) {
      void reconcile(nextClient, generation);
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: () =>
      run(async (client) => {
        const { subscribeToWebPush } = await import("./web-push.runtime.ts");
        await subscribeToWebPush(client);
        const { getWebPushPreferences } = await import("./web-push.runtime.ts");
        publish({ subscribed: true, preferences: await getWebPushPreferences(client) });
      }),
    disable: () =>
      run(async (client) => {
        const { unsubscribeFromWebPush } = await import("./web-push.runtime.ts");
        await unsubscribeFromWebPush(client);
        publish({ subscribed: false, preferences: null });
      }),
    sendTest: () =>
      run(async (client) => {
        const { sendTestWebPush } = await import("./web-push.runtime.ts");
        await sendTestWebPush(client);
      }),
    setUserPreferences: (preferences) =>
      run(async (client) => {
        const { setWebPushPreferences } = await import("./web-push.runtime.ts");
        publish({ preferences: await setWebPushPreferences(client, "user", preferences) });
      }),
    setDevicePreferences: (preferences) =>
      run(async (client) => {
        const { setWebPushPreferences } = await import("./web-push.runtime.ts");
        publish({ preferences: await setWebPushPreferences(client, "device", preferences) });
      }),
    dispose() {
      disposed = true;
      connectedClient = null;
      connectionGeneration += 1;
      stopGateway();
      listeners.clear();
    },
  };
}
