Pod::Spec.new do |s|
  s.name           = 'NeoPinLive'
  s.version        = '1.0.0'
  s.summary        = 'The search on the lock screen as a Live Activity'
  s.description    = 'Starts, updates and ends the Live Activity of a NeoPin find. The widget extension in targets/widgets draws it.'
  s.license        = 'MIT'
  s.author         = 'vxnsin'
  s.homepage       = 'https://github.com/vxnsin/NeoPin'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/vxnsin/NeoPin.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
