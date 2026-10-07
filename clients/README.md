# Client apps

The three client apps live in their own (private) repositories:

| App | Repository |
| --- | --- |
| Customer | `Delivery-Plus0/delivery-plus-customer-app` |
| Driver | `Delivery-Plus0/delivery-plus-driver-app` |
| Restaurant | `Delivery-Plus0/delivery-plus-restaurant-app` |

## Shared UI kit manifest

`kit-manifest.json` is the **canonical list of the shared UI kit files and their hashes** (#155). Each app's CI runs `npm run kit:check -- --remote`. That check fails when the app's kit differs from this manifest, which keeps the three apps' kits byte-identical even though their repositories can't read each other. The manifest has only paths and SHA-256 hashes, never app code.

To change the kit:
1. Change it in one app and run `npm run kit:update`.
2. Copy it to the other apps with `npm run kit:sync`.
3. Copy that app's `kit-manifest.json` here and merge it first.
4. Merge the app PRs.

The full guide is `docs/ui-kit.md` in any app.
