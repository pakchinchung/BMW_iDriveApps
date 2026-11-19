# Waze cards on cluster

Waze's turn card and arrival card over the Waze map that
[Maps on cluster](../../apps/robertn_waze_cluster) shows on the instrument
cluster. CarPlay's cluster map for Waze carries neither; this tool takes them
from the central screen.

The detection and drawing are [Waze Cards](https://github.com/noth4m4d/mgu-hamadstools)
by h4m4d (MIT, `LICENSE`): `src/card.js` is its `card.js` as measured on the
car, without its own map for the cluster's map area.

## How it works

- `cards.js` (root, `waze-cluster-cards.service`) asks cluster-render every
  second whether waze-on-cluster's map video on the `map` target is shown.
- While it is, it grabs the central screen with `winston-grabber` (4 frames
  a second, 1 while no card has been seen for 20 s) and finds Waze's cards:
  Waze's full-screen map, or CarPlay's Dashboard.
- It draws them as two overlay images on `map`, in the map's own scene,
  inside the part of the map the gauges leave visible (504x368 at 286,72, the
  safe area Maps on cluster gives CarPlay): the turn card at its top, the
  arrival card at its bottom.
- While the map is not on the cluster (BMW's map, Show on Off or HUD, no
  phone), nothing is grabbed or drawn, so the cards never hold the map area
  on their own.

Nothing is sent to CarPlay, the navigation or the HMI.

## Control

The Maps on cluster app's **Show Waze's turn and arrival cards** checkbox,
over `/dev/shm/waze-cluster-cards/ctl.sock` (root:tm_oap_app, 0660),
newline-delimited JSON:

| | |
|---|---|
| app -> service | `{"cmd":"status"}`, `{"cmd":"cards","on":0\|1}` |
| service -> app | `{"ev":"status","on":0\|1,"state":"off"\|"unavailable"\|"waiting"\|"looking"\|"showing","view":"full screen"\|"Dashboard"\|""}`, `{"ev":"cards-reply","ok","reason"}` |

The switch is kept in `/var/opt/waze-cluster-cards/state/settings.json`
(on without it). `/var/opt/waze-cluster-cards/waze-cluster-cards.json` can
change the timing and the cards' place and width (`DEFAULTS` in
`src/cards.js`). The log is `/var/opt/waze-cluster-cards/waze-cluster-cards.log`.

On the head unit, `node /var/opt/waze-cluster-cards/current/cards.js --once`
grabs one frame and prints what it finds.

## Test

```sh
node native/waze-cluster-cards/test/cards_test.js
```

Synthetic frames of both views, the service loop against a fake cluster-render
client, and the control socket.
