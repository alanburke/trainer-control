# Trainer Control

A small web app to ride a smart trainer with virtual gears, shifted by a Zwift Click.
Built for a Decathlon Van Rysel D100 with Zwift Cog & Click.

- Shows power, cadence (estimated from speed), virtual speed and gear.
- 24 virtual gears: each gear adds 1% of simulated gradient (gear 12 = flat).
- Zwift Click + / − shift gears. On-screen buttons and arrow keys work too.

Runs entirely in the browser using Web Bluetooth. No server needed.

## Using it

- **iPhone:** open the site in the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser (Safari has no Web Bluetooth).
- **Android / Mac / PC:** Chrome or Edge.

Close Zwift first: the trainer and Click only accept one app at a time.

## Running locally

```
python3 -m http.server 8080
```

then open http://localhost:8080 in Chrome.

## Releasing an update

```
./release.sh "What changed"
```

This bumps the version (shown next to the page title), commits and pushes.
GitHub Pages updates within a minute or two.

## Tuning

In `gears.js`:

- `GRADE_PER_GEAR`: how strong each shift feels.
- `CADENCE_RPM_PER_KMH`: cadence calibration (60 rpm = 18.06 km/h on the D100 with the Cog).

## Credits

The Zwift Click protocol details come from the open-source
[BikeControl](https://github.com/OpenBikeControl/bikecontrol) and
[zwiftplay](https://github.com/ajchellew/zwiftplay) projects.
