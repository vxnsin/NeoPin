package de.vensin.neopin.widgets

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// The snapshot the app wrote, see lib/widgets.ts for the fields.
data class WPerson(
  val id: String,
  val userId: Int?,
  val name: String,
  val initials: String,
  val online: Boolean,
  val distanceM: Int?,
  val lastPing: Long?,
  val battery: Int?,
  val groupIds: List<Int>
)

data class WMe(val name: String, val hiddenUntil: Long?, val battery: Int?, val sharing: Boolean)

data class WGroup(val id: Int, val name: String)

data class Snapshot(val updatedAt: Long, val me: WMe?, val people: List<WPerson>, val groups: List<WGroup>)

object Store {
  private const val PREFS = "neopin_widgets"
  private const val SNAPSHOT = "snapshot"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun save(context: Context, json: String) {
    prefs(context).edit().putString(SNAPSHOT, json).apply()
  }

  fun load(context: Context): Snapshot? {
    val raw = prefs(context).getString(SNAPSHOT, null)
    if (raw.isNullOrEmpty()) return null
    return try {
      parse(JSONObject(raw))
    } catch (e: Exception) {
      null
    }
  }

  // Which person a Person widget shows, by widget id.
  fun personFor(context: Context, widgetId: Int): String? = prefs(context).getString("person:$widgetId", null)

  fun savePersonFor(context: Context, widgetId: Int, personId: String) {
    prefs(context).edit().putString("person:$widgetId", personId).apply()
  }

  fun forgetPersonFor(context: Context, widgetId: Int) {
    prefs(context).edit().remove("person:$widgetId").apply()
  }

  private fun JSONObject.intOrNull(key: String): Int? = if (isNull(key)) null else optInt(key)
  private fun JSONObject.longOrNull(key: String): Long? = if (isNull(key)) null else optLong(key)

  private fun parse(o: JSONObject): Snapshot {
    val me = o.optJSONObject("me")?.let {
      WMe(it.optString("name"), it.longOrNull("hiddenUntil"), it.intOrNull("battery"), it.optBoolean("sharing"))
    }
    val people = ArrayList<WPerson>()
    val list: JSONArray = o.optJSONArray("people") ?: JSONArray()
    for (i in 0 until list.length()) {
      val p = list.getJSONObject(i)
      val ids = ArrayList<Int>()
      val groupIds = p.optJSONArray("groupIds") ?: JSONArray()
      for (j in 0 until groupIds.length()) ids.add(groupIds.getInt(j))
      people.add(
        WPerson(
          p.optString("id"),
          p.intOrNull("userId"),
          p.optString("name"),
          p.optString("initials"),
          p.optBoolean("online"),
          p.intOrNull("distanceM"),
          p.longOrNull("lastPing"),
          p.intOrNull("battery"),
          ids
        )
      )
    }
    val groups = ArrayList<WGroup>()
    val glist: JSONArray = o.optJSONArray("groups") ?: JSONArray()
    for (i in 0 until glist.length()) {
      val g = glist.getJSONObject(i)
      groups.add(WGroup(g.optInt("id"), g.optString("name")))
    }
    return Snapshot(o.optLong("updatedAt"), me, people, groups)
  }
}
