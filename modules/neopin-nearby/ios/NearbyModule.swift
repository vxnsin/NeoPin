import CoreBluetooth
import ExpoModulesCore

// Bluetooth for the last metres of a find: the phone sends out the session's UUID and listens
// for it. Every sighting reports the signal strength, the app turns that into "very close".
// iOS only lets an app in the foreground send out a service UUID, which is the one it needs.
public class NearbyModule: Module {
  private var radio: NearbyRadio?

  public func definition() -> ModuleDefinition {
    Name("NeoPinNearby")
    Events("onSighting", "onState")

    // Resolves with "ready", "off", "unsupported" or "unauthorized".
    AsyncFunction("start") { (uuid: String, promise: Promise) in
      self.radio?.stop()
      let radio = NearbyRadio(uuid: uuid) { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      self.radio = radio
      radio.start(promise)
    }

    AsyncFunction("stop") {
      self.radio?.stop()
      self.radio = nil
    }

    OnDestroy {
      self.radio?.stop()
      self.radio = nil
    }
  }
}

final class NearbyRadio: NSObject, CBPeripheralManagerDelegate, CBCentralManagerDelegate {
  private let service: CBUUID
  private let emit: (String, [String: Any]) -> Void
  private var peripheral: CBPeripheralManager!
  private var central: CBCentralManager!
  private var pending: Promise?
  private var running = false

  init(uuid: String, emit: @escaping (String, [String: Any]) -> Void) {
    service = CBUUID(string: uuid)
    self.emit = emit
    super.init()
    peripheral = CBPeripheralManager(delegate: self, queue: nil)
    central = CBCentralManager(delegate: self, queue: nil)
  }

  func start(_ promise: Promise) {
    pending = promise
    tryStart()
  }

  // Both managers have to be powered on; iOS says so a moment after they are made.
  private func tryStart() {
    guard let promise = pending else { return }
    for state in [peripheral.state, central.state] {
      switch state {
      case .unauthorized:
        pending = nil
        promise.resolve("unauthorized")
        return
      case .unsupported:
        pending = nil
        promise.resolve("unsupported")
        return
      case .poweredOff:
        pending = nil
        promise.resolve("off")
        return
      case .poweredOn:
        continue
      default:
        return // unknown or resetting, a delegate call follows
      }
    }
    peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [service]])
    central.scanForPeripherals(withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    running = true
    pending = nil
    promise.resolve("ready")
  }

  func stop() {
    pending = nil
    running = false
    if peripheral.isAdvertising {
      peripheral.stopAdvertising()
    }
    if central.isScanning {
      central.stopScan()
    }
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    if running && peripheral.state != .poweredOn {
      emit("onState", ["state": peripheral.state == .poweredOff ? "off" : "failed"])
    }
    tryStart()
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if running && central.state != .poweredOn {
      emit("onState", ["state": central.state == .poweredOff ? "off" : "failed"])
    }
    tryStart()
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    emit("onSighting", ["rssi": RSSI.intValue, "at": Date().timeIntervalSince1970 * 1000])
  }
}
