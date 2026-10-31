# Datacenter Sim price feed

Real-world prices for every GPU, CPU, laptop, server and other part in the game. The game downloads `prices.json` and uses those prices in its shop (ByteMart).

| File | What it does |
|---|---|
| `hardware.json` | The hardware database: names, specs, baseline prices and search hints |
| `fetch-prices.js` | Looks up every item on Best Buy and eBay and writes `prices.json` |
| `server.js` | Optional: hosts the prices as a web service instead of a file |
| `gen-catalog.js` | Turns `hardware.json` into the game's `Catalog.luau` |
| `overrides.json` | Manual prices that win over everything, e.g. `{ "gpu_5090": 3999 }` |
| `../.github/workflows/update-prices.yml` | GitHub Action that refreshes `prices.json` every day |

You need Node 18 or newer. There's nothing to `npm install`.

## Setup (GitHub, free)

1. Push this repo to GitHub. The repo must be **public** so the game can download the file. If you want to keep your game code private, make a separate public repo that holds only `price-feed/` and `.github/`.
2. Get free API keys. You can use either one, or both:
   - Best Buy: https://developer.bestbuy.com
   - eBay: https://developer.ebay.com. Create a **Production** keyset. The App ID is your client ID and the Cert ID is your client secret.
3. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `BESTBUY_API_KEY`
   - `EBAY_CLIENT_ID`
   - `EBAY_CLIENT_SECRET`
4. Go to the **Actions** tab, pick **Update hardware prices** and click **Run workflow**. After that it runs every day by itself.
5. In the game, open `ReplicatedStorage.Shared.Config` and set `Config.Market.FeedUrl` to:
   `https://raw.githubusercontent.com/<you>/<repo>/main/price-feed/prices.json`
6. In Roblox Studio, turn on **Game Settings → Security → Allow HTTP Requests**.

Without keys, the script still writes a valid `prices.json` using the baseline prices, so the game always works.

When keys are set but no store price comes back at all (refused keys, every search failing), the run **fails** and leaves `prices.json` as it was, printing the first error per store (for example `ebay failed: login failed: HTTP 401 ...`). A store whose keys are refused is skipped for the rest of the run instead of being retried for every item. `prices.json` is only rewritten when a price changed, or every 3 days so the game never sees it as stale.

## Run it on your PC

```bash
node price-feed/fetch-prices.js --offline          # baseline only, no network
BESTBUY_API_KEY=xxx node price-feed/fetch-prices.js --verbose
node price-feed/fetch-prices.js --only gpu_5090,cpu_r9_9950x --verbose
```

On Windows PowerShell, set the key first with `$env:BESTBUY_API_KEY="xxx"`.

Partial runs (`--only`) retain untouched price records and their trend history, then recompute bundles using the retained and updated component prices. The `live` count describes provider-sourced records in the resulting file, including retained records.

Run the regression tests with `npm --prefix price-feed test` (use `npm.cmd` in PowerShell if script execution is restricted). The tests use temporary files and simulated provider responses; no API credentials or network access are needed.

eBay access tokens are cached in memory and renewed before expiry. If a search returns HTTP 401, the collector discards the token, obtains a new one and retries that search once. Other authorization errors still fall back through the normal per-item error handling.

## Host it as a service (optional)

On Render, Railway, Fly.io or a VPS:

- Start command: `node price-feed/server.js`
- Env vars: the API keys above, plus `REFRESH_HOURS` (default 12).
- The game URL is then `https://<your-service>/prices.json`.

A refresh is published in memory after its disk write succeeds. Write failures are logged and the service continues serving its previous in-memory feed.

## How a price is picked

1. **Search:** both stores are searched. Only listings whose title has every `must` word and none of the `not` words are kept, and only if the price is inside `min`–`max`. This drops cases, cables, laptops when looking for a GPU, and so on.
2. **Per store:** outliers are dropped, and the 35th-percentile price is used. That's a "cheap but real" street price.
3. **Combine:** if both stores answered, their two prices are averaged. The result is capped at 3x up or down from the baseline.
4. **Bundles:** prebuilt PCs, the NAS and GPU servers are priced from their parts, plus a small markup for prebuilts.
5. **Game safety:** the game also clamps every price to between 0.5x and 2.5x the baseline. If the file is older than 14 days, it falls back to the baseline.

Manual overrides take precedence, including when a component is used in a bundle. Nested bundles are resolved by dependency, so catalog order does not affect their price; cyclic bundle references fail the refresh with an error.

## Add or change hardware

1. Edit `hardware.json`. Copy a similar item and change its `id`, `name`, specs, `price` and `feed`.
2. Run `node price-feed/gen-catalog.js`.
3. Copy `src/shared/Catalog.luau` into `ReplicatedStorage.Shared.Catalog` in Studio.

## Note about real product names

The shop shows real product names by default. Roblox can take down experiences over trademark complaints. Setting `Config.Market.UseRealNames = false` switches every item to the generic name in its `alt` field, and prices keep working the same way.
