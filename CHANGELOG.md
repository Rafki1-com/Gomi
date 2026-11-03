# Gomi V1.1.0

## UI and usability
- Replaced decorative text-symbol controls with consistent inline SVG icons.
- Simplified the color palette and reduced gradients/glow effects.
- Improved mobile typography, control sizes, and spacing.
- On narrow screens, the remote video becomes the main view and the local preview becomes a compact picture-in-picture panel.

## Camera and microphone diagnostics
- Added an in-app guide for granting camera/microphone permissions on Chrome for Android.
- Added distinct messages for blocked permissions, missing devices, busy cameras, unsupported constraints, and connection errors.
- The browser still requires the user to grant camera/microphone access; the application cannot override browser or Android permissions.

## Verification
- `npm test`: 6/6 tests passed.
- `npm run check`: passed.
- Live camera/WebRTC verification still requires testing from real devices and networks. TURN is still recommended for networks where STUN-only connectivity fails.
