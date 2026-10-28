package de.vensin.neopin.widgets

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView

class GroupWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, Widgets.group(context, id))
  }

  // Taller widget, more rows.
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    manager.updateAppWidget(id, Widgets.group(context, id))
  }
}

class MeWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, Widgets.me(context))
  }
}

class PersonWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, Widgets.person(context, id))
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    for (id in ids) Store.forgetPersonFor(context, id)
  }
}

// Asked once when a Person widget is added: who to show.
class PersonConfigActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish()
      return
    }
    val people = Store.load(this)?.people ?: emptyList()
    val list = ListView(this)
    setContentView(list)
    if (people.isEmpty()) {
      list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, listOf("Open NeoPin first, then add the widget again"))
      list.setOnItemClickListener { _, _, _, _ -> finish() }
      return
    }
    list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, people.map { it.name })
    list.setOnItemClickListener { _, _, position, _ ->
      Store.savePersonFor(this, widgetId, people[position].id)
      AppWidgetManager.getInstance(this).updateAppWidget(widgetId, Widgets.person(this, widgetId))
      setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
      finish()
    }
  }
}
