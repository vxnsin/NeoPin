import 'package:flutter/material.dart';


// === USAGE === //

//  Surface = Background Color
//
//  Primary = First Layer of Panels and/or Buttons
//
//  Secondary = Activated Buttons and/or
//  Borders of Interest
//
//  Tertiary = Text Color

ThemeData lightMode = ThemeData(
    brightness: Brightness.light,
    colorScheme: ColorScheme.light(
        surface: Color.fromARGB(255, 255, 255, 255),
        onSurface: Color.fromARGB(255, 208, 208, 216),

        primary: Colors.black,
        secondary: Colors.red,
        onSecondary: Colors.white,
    ),
);

ThemeData darkMode = ThemeData(
    brightness: Brightness.dark,
    colorScheme: ColorScheme.dark(

        surface: Color.fromARGB(255, 9, 10, 13),
        onSurface: Color.fromARGB(255, 44, 45, 51),

        primary: Colors.white,
        secondary: Colors.red,
        onSecondary: Colors.white,

        //surface: Colors.black,
        //primary: Colors.black54,
        //secondary: Colors.redAccent,
        //tertiary: Colors.white,
    ),
);