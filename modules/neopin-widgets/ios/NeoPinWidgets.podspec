Pod::Spec.new do |s|
  s.name           = 'NeoPinWidgets'
  s.version        = '1.0.0'
  s.summary        = 'Hands the NeoPin snapshot to the home screen widgets'
  s.description    = 'Writes what the app knows into the shared app group and asks WidgetKit to redraw.'
  s.license        = 'MIT'
  s.author         = 'vxnsin'
  s.homepage       = 'https://github.com/vxnsin/NeoPin'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/vxnsin/NeoPin.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
