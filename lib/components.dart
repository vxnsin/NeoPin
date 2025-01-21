import 'package:flutter/material.dart';

class MyButton extends StatelessWidget {
  final WhenPressed;
  final ButtonText;
  final ButtonIcon;

  const MyButton({
    super.key,
    required this.WhenPressed,
    this.ButtonText,
    this.ButtonIcon,
  });

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      style: ButtonStyle(
        padding: WidgetStateProperty.all(const EdgeInsets.all(20)),
        backgroundColor: WidgetStateProperty.all(Theme.of(context).colorScheme.secondary),
        foregroundColor: WidgetStateProperty.all(Theme.of(context).colorScheme.onSecondary),
      ),
      onPressed: WhenPressed,
      child: Text(ButtonText),
    );
  }
}

class LoginField extends StatelessWidget {
  final controller;
  final String hintText;
  final String labelText;
  final bool obscureText;
  final hintIcon;

  const LoginField({
    super.key,
    required this.controller,
    required this.hintText,
    required this.labelText,
    required this.obscureText,
    required this.hintIcon,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(

      controller: controller,
      obscureText: obscureText,

      style: TextStyle(
        color: Theme.of(context).colorScheme.primary,
      ),

      decoration: InputDecoration(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(20),
        ),

        icon: hintIcon,
        iconColor: Theme.of(context).colorScheme.primary,

        labelText: labelText,
        hintText: hintText,

        labelStyle: TextStyle(color: Theme.of(context).colorScheme.primary),
        hintStyle: TextStyle(color: Theme.of(context).colorScheme.onSurface),

        fillColor: Theme.of(context).colorScheme.onSurface,

      ),
    );
  }
}
