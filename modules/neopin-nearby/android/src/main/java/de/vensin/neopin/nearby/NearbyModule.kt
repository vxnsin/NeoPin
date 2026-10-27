package de.vensin.neopin.nearby

import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelUuid
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

// Bluetooth for the last metres of a find: both phones send out the session's UUID and listen
// for it. Every sighting reports the signal strength, the app turns that into "very close".
class NearbyModule : Module() {
  private var advertising: AdvertiseCallback? = null
  private var scanning: ScanCallback? = null

  override fun definition() = ModuleDefinition {
    Name("NeoPinNearby")
    Events("onSighting", "onState")

    // Resolves with "ready", "off", "unsupported" or "unauthorized".
    AsyncFunction("start") { uuid: String ->
      stopRadio()
      val context = appContext.reactContext ?: return@AsyncFunction "unsupported"
      val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
      if (adapter == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
        return@AsyncFunction "unsupported"
      }
      if (!adapter.isEnabled) return@AsyncFunction "off"
      val service = ParcelUuid(UUID.fromString(uuid))
      try {
        val advertiser = adapter.bluetoothLeAdvertiser ?: return@AsyncFunction "unsupported"
        val scanner = adapter.bluetoothLeScanner ?: return@AsyncFunction "unsupported"

        val advertise = object : AdvertiseCallback() {
          override fun onStartFailure(errorCode: Int) {
            sendEvent("onState", mapOf("state" to "failed", "code" to errorCode))
          }
        }
        advertiser.startAdvertising(
          AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build(),
          AdvertiseData.Builder().addServiceUuid(service).setIncludeDeviceName(false).build(),
          advertise
        )
        advertising = advertise

        val scan = object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) {
            sendEvent("onSighting", mapOf("rssi" to result.rssi, "at" to System.currentTimeMillis()))
          }

          override fun onScanFailed(errorCode: Int) {
            sendEvent("onState", mapOf("state" to "failed", "code" to errorCode))
          }
        }
        scanner.startScan(
          listOf(ScanFilter.Builder().setServiceUuid(service).build()),
          ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
          scan
        )
        scanning = scan
        "ready"
      } catch (e: SecurityException) {
        stopRadio()
        "unauthorized"
      }
    }

    AsyncFunction("stop") { stopRadio() }

    OnDestroy { stopRadio() }
  }

  private fun stopRadio() {
    val adapter = (appContext.reactContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    try {
      advertising?.let { adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
      scanning?.let { adapter?.bluetoothLeScanner?.stopScan(it) }
    } catch (e: SecurityException) {
      // Without the permission nothing was ever started.
    }
    advertising = null
    scanning = null
  }
}
