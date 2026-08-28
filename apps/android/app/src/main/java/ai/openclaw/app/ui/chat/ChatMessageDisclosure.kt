package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatFullMessageState
import ai.openclaw.app.chat.ChatFullMessageUnavailable
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private class ChatMessageDisclosureRead(
  val message: ChatMessage,
  val read: ChatController.FullMessageRead,
) {
  var job: Job? = null

  fun matches(candidate: ChatMessage): Boolean =
    candidate.role == "assistant" &&
      candidate.truncated &&
      candidate.entryId == message.entryId &&
      candidate.content == message.content
}

@Composable
internal fun ChatMessageDisclosure(
  messages: List<ChatMessage>,
  owner: ChatComposerOwner,
  selectionGeneration: Long,
  catalogRevision: Long,
  prepareRead: (ChatMessage) -> ChatController.FullMessageRead?,
  content: @Composable (@Composable (ChatMessage) -> Unit) -> Unit,
) {
  // The selected read belongs to the list, not a recycled row. Rekey only its state,
  // leaving ordinary bubble expansion, menus, and media at their existing owners.
  val scope = key(owner, selectionGeneration, catalogRevision) { rememberCoroutineScope() }
  var selected by remember(scope) { mutableStateOf<ChatMessageDisclosureRead?>(null) }
  var expanded by remember(scope) { mutableStateOf(false) }
  val selection = selected
  val active = selection?.takeIf { messages.any(it::matches) }
  if (selection != null && active == null) {
    SideEffect {
      // Removal or a changed preview retires the cache permanently, even if reinserted later.
      if (selected === selection) {
        selection.job?.cancel()
        selected = null
        expanded = false
      }
    }
  }
  val result =
    key(active) {
      active
        ?.read
        ?.state
        ?.collectAsState()
        ?.value
    }

  fun open(
    message: ChatMessage,
    retry: Boolean = false,
  ) {
    // Admission happens in the tap, before queued coroutine work can outlive this render.
    val admitted = prepareRead(message) ?: return
    if (retry || selected?.matches(message) != true) {
      selected?.job?.cancel()
      val next = ChatMessageDisclosureRead(message, admitted)
      selected = next
      next.job = scope.launch { admitted.execute() }
    }
    expanded = true
  }

  fun close() {
    expanded = false
    // Retry can replace the holder before recomposition; cancel it in this tap,
    // before a queued transport write can resume ahead of the next frame.
    val current = selected
    if (current?.read?.state?.value == ChatFullMessageState.Loading) {
      current.job?.cancel()
      selected = null
    }
  }

  content { message ->
    if (message.role == "assistant" && message.truncated && !message.entryId.isNullOrBlank()) {
      ChatMessageDisclosureButton(nativeString("View all")) { open(message) }
    }
  }
  if (expanded && active != null) {
    if (result is ChatFullMessageState.Loaded) {
      ChatTextReaderDialog(
        text = chatMessagePlainText(result.content),
        title = nativeString("Full text"),
        dismissLabel = nativeString("Close"),
        onDismiss = ::close,
      )
    } else {
      AlertDialog(
        onDismissRequest = ::close,
        title = { Text(nativeString("Full text")) },
        text = {
          Text(
            when (result) {
              is ChatFullMessageState.Unavailable ->
                when (result.reason) {
                  ChatFullMessageUnavailable.GatewayUpdate -> nativeString("Update the Gateway to load the full message.")
                  ChatFullMessageUnavailable.Disconnected -> nativeString("Reconnect to load the full message.")
                  ChatFullMessageUnavailable.NotFound -> nativeString("The full message is no longer available.")
                  ChatFullMessageUnavailable.TooLarge -> nativeString("The full message is too large to display.")
                  ChatFullMessageUnavailable.Unreadable -> nativeString("The full message could not be loaded.")
                }
              ChatFullMessageState.Failed -> nativeString("The full message could not be loaded.")
              else -> nativeString("Loading full message…")
            },
            style = ClawTheme.type.caption,
          )
        },
        confirmButton = { TextButton(onClick = ::close) { Text(nativeString("Close")) } },
        dismissButton = {
          if (result == ChatFullMessageState.Failed) {
            TextButton(onClick = { open(active.message, retry = true) }) { Text(nativeString("Retry")) }
          }
        },
      )
    }
  }
}

@Composable
internal fun ChatMessageDisclosureButton(
  label: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(8.dp),
    color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f),
    contentColor = ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.6f)),
  ) {
    Text(
      text = label,
      style = ClawTheme.type.body.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
    )
  }
}
