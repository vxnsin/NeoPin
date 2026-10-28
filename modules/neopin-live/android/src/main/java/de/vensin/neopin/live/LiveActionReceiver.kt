package de.vensin.neopin.live

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// The Stop button on the notification. The module leaves its listener here while it lives.
class LiveActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_STOP) listener?.invoke("stop")
  }

  companion object {
    const val ACTION_STOP = "de.vensin.neopin.live.STOP"
    var listener: ((String) -> Unit)? = null
  }
}
