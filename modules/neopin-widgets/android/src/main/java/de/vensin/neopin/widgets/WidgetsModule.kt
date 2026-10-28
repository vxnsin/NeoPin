package de.vensin.neopin.widgets

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The app hands over its snapshot, the widgets get redrawn from it.
class WidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NeoPinWidgets")

    AsyncFunction("update") { json: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      Store.save(context, json)
      Widgets.refreshAll(context)
    }
  }
}
