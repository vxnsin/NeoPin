package de.vensin.neopin.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// What the lock screen shows while a find runs.
class LiveContent : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  // The few characters that fit next to the icon in the status bar, "120 m".
  @Field val short: String = ""
  // Where to point, degrees clockwise from straight up. Null shows no arrow.
  @Field val arrowDeg: Double? = null
}

private const val CHANNEL = "find"
private const val NOTIFICATION_ID = 7001
private const val RED = 0xFFD3171E.toInt()

// The search as an ongoing notification: arrow, metres, name and a Stop button. Android 16
// promotes it to a live update that keeps the metres in the status bar.
class LiveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NeoPinLive")
    Events("onAction")

    OnCreate {
      LiveActionReceiver.listener = { action -> sendEvent("onAction", mapOf("action" to action)) }
    }

    OnDestroy {
      LiveActionReceiver.listener = null
      hide()
    }

    // Shows or updates the notification. Resolves "shown", or "denied" when notifications are off.
    AsyncFunction("show") { content: LiveContent -> show(content) }

    AsyncFunction("hide") { hide() }
  }

  private fun show(content: LiveContent): String {
    val context = appContext.reactContext ?: return "failed"
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return "denied"
    ensureChannel(context)

    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return "failed"
    val open = PendingIntent.getActivity(context, 0, launch, flags)
    val stop = PendingIntent.getBroadcast(
      context,
      1,
      Intent(context, LiveActionReceiver::class.java).setAction(LiveActionReceiver.ACTION_STOP),
      flags
    )

    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.neopin_live_arrow)
      .setColor(RED)
      .setContentTitle(content.title)
      .setContentText(content.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
    content.arrowDeg?.let { builder.setLargeIcon(arrowBitmap(it.toFloat())) }

    var notification = builder.build()
    if (Build.VERSION.SDK_INT >= 36) {
      notification = Notification.Builder.recoverBuilder(context, notification)
        .setRequestPromotedOngoing(true)
        .setShortCriticalText(content.short)
        .build()
    }
    return try {
      manager.notify(NOTIFICATION_ID, notification)
      "shown"
    } catch (e: SecurityException) {
      "denied"
    }
  }

  private fun hide() {
    val context = appContext.reactContext ?: return
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }

  // Silent on purpose: it changes every second, nobody wants a sound for that.
  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Find me", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "Direction and distance while you find somebody"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  // The arrow from the app, turned towards the other phone.
  private fun arrowBitmap(degrees: Float): Bitmap {
    val size = 128
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val path = Path().apply {
      moveTo(12f, 2f)
      lineTo(4.5f, 20.29f)
      lineTo(5.21f, 21f)
      lineTo(12f, 18f)
      lineTo(18.79f, 21f)
      lineTo(19.5f, 20.29f)
      close()
      transform(Matrix().apply { setScale(size / 24f, size / 24f) })
    }
    canvas.rotate(degrees, size / 2f, size / 2f)
    canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = RED; style = Paint.Style.FILL })
    return bitmap
  }
}
