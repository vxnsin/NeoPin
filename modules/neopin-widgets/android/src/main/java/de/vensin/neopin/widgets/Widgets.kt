package de.vensin.neopin.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

// Draws the widgets from the stored snapshot. Everything a tap does goes through a link into
// the app, see lib/widgets.ts.
object Widgets {
  const val RED = 0xFFD3171E.toInt()
  const val GREEN = 0xFF22C55E.toInt()
  const val GREY = 0xFF4B5563.toInt()
  const val MUTED = 0xFF98A2B3.toInt()
  const val WHITE = 0xFFFFFFFF.toInt()

  // Avatar colours, one per person by their id.
  private val PALETTE = intArrayOf(
    0xFFD3171E.toInt(), 0xFF1D4ED8.toInt(), 0xFF6D28D9.toInt(), 0xFF0F766E.toInt(),
    0xFFB45309.toInt(), 0xFFBE185D.toInt(), 0xFF4D7C0F.toInt(), 0xFF0E7490.toInt()
  )

  private val PROVIDERS = listOf(GroupWidget::class.java, MeWidget::class.java, PersonWidget::class.java)

  fun refreshAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    for (provider in PROVIDERS) {
      val ids = manager.getAppWidgetIds(ComponentName(context, provider))
      if (ids.isEmpty()) continue
      val intent = Intent(context, provider)
        .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      context.sendBroadcast(intent)
    }
  }

  // Opens the app at the map with a query that says what to do.
  fun open(context: Context, query: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("neopin://map?$query"))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(context, query.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  fun metres(m: Int?): String = when {
    m == null -> "–"
    m < 1000 -> "$m m"
    m < 10_000 -> String.format("%.1f km", m / 1000.0)
    else -> "${m / 1000} km"
  }

  fun ago(at: Long?, now: Long = System.currentTimeMillis()): String {
    if (at == null) return ""
    val s = (now - at) / 1000
    return when {
      s < 60 -> "now"
      s < 3600 -> "${s / 60} min"
      s < 86_400 -> "${s / 3600} h"
      else -> "${s / 86_400} d"
    }
  }

  fun avatarColor(id: String): Int = PALETTE[Math.floorMod(id.hashCode(), PALETTE.size)]

  fun meta(p: WPerson): String = when {
    !p.online -> "Offline"
    p.battery != null -> "Online · ${p.battery} %"
    else -> "Online"
  }

  // Initials in a coloured circle, with the green ring while online.
  fun fillAvatar(views: RemoteViews, p: WPerson) {
    views.setTextViewText(R.id.initials, p.initials)
    views.setInt(R.id.avatar, "setColorFilter", avatarColor(p.id))
    views.setInt(R.id.ring, "setColorFilter", if (p.online) GREEN else GREY)
  }

  fun empty(context: Context, text: String): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.widget_empty)
    views.setTextViewText(R.id.text, text)
    views.setOnClickPendingIntent(R.id.root, open(context, "from=widget"))
    return views
  }

  // People: as many rows as the height takes.
  fun group(context: Context, widgetId: Int): RemoteViews {
    val snapshot = Store.load(context) ?: return empty(context, "Open NeoPin to sign in")
    val views = RemoteViews(context.packageName, R.layout.widget_group)
    views.setTextViewText(R.id.title, "People")
    views.setOnClickPendingIntent(R.id.root, open(context, "from=widget"))
    views.removeAllViews(R.id.rows)
    if (snapshot.people.isEmpty()) {
      views.setViewVisibility(R.id.nobody, View.VISIBLE)
      return views
    }
    views.setViewVisibility(R.id.nobody, View.GONE)
    val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId)
    val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
    val rows = ((height - 34) / 40).coerceIn(2, 7)
    for (p in snapshot.people.take(rows)) {
      val row = RemoteViews(context.packageName, R.layout.widget_row)
      fillAvatar(row, p)
      row.setTextViewText(R.id.name, p.name)
      row.setTextViewText(R.id.meta, meta(p))
      row.setTextViewText(R.id.dist, metres(p.distanceM))
      row.setTextViewText(R.id.when_, ago(p.lastPing))
      row.setOnClickPendingIntent(R.id.row, open(context, "person=${Uri.encode(p.id)}"))
      views.addView(R.id.rows, row)
    }
    return views
  }

  // Me: sharing or invisible, and the button that switches.
  fun me(context: Context): RemoteViews {
    val me = Store.load(context)?.me ?: return empty(context, "Open NeoPin to sign in")
    val views = RemoteViews(context.packageName, R.layout.widget_me)
    val now = System.currentTimeMillis()
    val until = me.hiddenUntil
    views.setOnClickPendingIntent(R.id.root, open(context, "from=widget"))
    if (until != null && until > now) {
      val left = (until - now) / 60_000
      val forever = left > 60L * 24 * 365
      views.setInt(R.id.dot, "setColorFilter", GREY)
      views.setTextViewText(R.id.status, "Invisible")
      views.setTextViewText(R.id.big, if (forever) "" else if (left >= 60) "${left / 60} h ${left % 60} min" else "$left min")
      views.setTextViewText(R.id.meta, if (forever) "until you switch it off" else "left")
      views.setTextViewText(R.id.button, "Show me again")
      views.setInt(R.id.button, "setBackgroundResource", R.drawable.widget_button_on)
      views.setTextColor(R.id.button, GREEN)
      views.setOnClickPendingIntent(R.id.button, open(context, "hide=0"))
    } else {
      views.setInt(R.id.dot, "setColorFilter", if (me.sharing) GREEN else GREY)
      views.setTextViewText(R.id.status, if (me.sharing) "Sharing" else "Not connected")
      views.setTextViewText(R.id.big, "")
      views.setTextViewText(R.id.meta, if (me.battery != null) "${me.battery} %" else "")
      views.setTextViewText(R.id.button, "Invisible 1 h")
      views.setInt(R.id.button, "setBackgroundResource", R.drawable.widget_button)
      views.setTextColor(R.id.button, WHITE)
      views.setOnClickPendingIntent(R.id.button, open(context, "hide=60"))
    }
    return views
  }

  // One person with the Find button.
  fun person(context: Context, widgetId: Int): RemoteViews {
    val snapshot = Store.load(context) ?: return empty(context, "Open NeoPin to sign in")
    val id = Store.personFor(context, widgetId) ?: return empty(context, "Tap to pick a person")
    val p = snapshot.people.firstOrNull { it.id == id } ?: return empty(context, "This person is gone")
    val views = RemoteViews(context.packageName, R.layout.widget_person)
    fillAvatar(views, p)
    views.setTextViewText(R.id.name, p.name)
    views.setTextViewText(R.id.meta, meta(p) + (if (p.lastPing != null && !p.online) " · ${ago(p.lastPing)}" else ""))
    views.setTextViewText(R.id.big, metres(p.distanceM))
    views.setOnClickPendingIntent(R.id.root, open(context, "person=${Uri.encode(p.id)}"))
    if (p.userId != null && p.online) {
      views.setViewVisibility(R.id.button, View.VISIBLE)
      views.setOnClickPendingIntent(R.id.button, open(context, "find=${p.userId}"))
    } else {
      views.setViewVisibility(R.id.button, View.GONE)
    }
    return views
  }
}
