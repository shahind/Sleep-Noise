# Sleep Noise

A tiny, battery-friendly pink & brown noise player for the night. Installable PWA, works offline.

**Open it:** https://shahind.github.io/Sleep-Noise/ — then "Add to Home Screen" to install it full screen.

- Pink (soft, like steady rain) or Brown (deep, like a waterfall)
- Tone, volume, and a sleep timer that gently fades out
- Pre-rendered seamless loop: no live audio processing while playing; audio hardware is suspended when paused
- Speaker & hearing protection: subsonic high-pass, loudness normalisation, peak cap, volume ceiling, soft fades
- Black, warm, low-brightness UI that dims itself when idle

Plain HTML/CSS/JS, no build step. To run locally: `python -m http.server` and open http://localhost:8000.
