# goto-recover

Google Search serves signed-out users result links as `/goto?url=<token>`. The `href` no longer contains the destination, the token is an opaque protobuf, and the `ping` attribute carries the same token.

The destination is still in the page, just not in the `href`. This repository documents where it is and how to pair it with each link, so that SERP parsers can keep resolving results without a request to `/goto`. It includes a reference implementation for pipelines and a bookmarklet that shows the same logic working in the browser.

## Where the destination lives

| Block | Token | Destination |
|---|---|---|
| Organic and video results | inline state `var m={...}` in a `<script>` | `about-this-result?...&req=<base64url>` in the same record: an unencrypted protobuf whose field 1 is the URL |
| AI Overview sources | HTML comment `<!--MARKER\|\|\|[...]-->` | either a full URL string in the same record, or only the domain root; in the latter case the "Show all" chips are followed by a link-preview comment whose first element is the URL |
| People also ask | HTML comment payload | full URL in the same record |
| Related results | comment payload and inline state | domain root plus title; the URL comes from the organic record with the same host and title |
| YouTube key moments | HTML template inside the script | parent video URL plus `t=<data-time>` |
| Ads, shopping offers, short-video carousels, sitelinks | DOM only | not present |

The AI Overview is not in the initial HTML. It arrives in a separate `/async/` response (`_id:B2Jtyd` in the request) that the page inserts into the DOM. A pipeline that only fetches the search page will resolve organic results; feeding that response body too covers the AI Overview.

## Pairing rule

Each source (the `var m` object, each comment payload) is a tree. Walk it bottom-up; every node aggregates the `/goto` tokens, the candidate URLs and the first text strings found below it. A node holding exactly one distinct token is that result's record, and its best candidate wins:

1. `exact` – field 1 of a `req` protobuf. A bare domain root here is kept: home pages rank too
2. `embedded` – a complete URL string, not on a Google host, with a path or query. A bare root found as a string is a label, not a destination, and is demoted to `domain`
3. `adjacent` – the link-preview comment that directly follows an anchor, accepted only when its host matches the token's own record
4. `inferred` – a domain-only record borrows the URL of a record with the same host and title
5. `derived` – key moments: parent video URL plus `t=`
6. `domain` – only the domain is known

Nodes with two or more tokens are never paired. If the data does not isolate a token with its URL, the token stays unresolved.

### Decoding `req`

```
base64url  -> bytes
bytes[0]   == 0x0a          field 1, length-delimited
bytes[1..] varint length
next N bytes                UTF-8 URL
```

### Parsing

- `var m={` is followed by a JSON object; take the balanced `{...}` and `JSON.parse` it.
- Comment payloads are `MARKER|||[...]` with HTML-escaped JSON (`&quot;`, `&amp;`); unescape before parsing.
- The mapping relies on record structure, not on class names or array positions.

## Reference implementation: `resolve.js`

Node, no dependencies, no DOM. Takes the raw HTML of the search page and, optionally, the bodies of the `/async/` responses, and returns a map `token -> { url, kind, host }`.

```js
const { resolve } = require('./resolve');
const { tokens, stats } = resolve([searchHtml, asyncBody]);
tokens.get(token); // { url, kind, host }
```

```
node resolve.js page.html [async.txt ...]     JSON on stdout
node resolve.js --csv page.html               token,url,kind
```

`stats` reports how many tokens the input contained, how many were resolved and by which rule. The bookmarklet below produces the same map from the live DOM.

## Bookmarklet (demo)

Runs the same rules in the browser and rewrites the links in place, so the result can be checked on a real page.

1. Open `dist/index.html` and drag the button to your bookmarks bar, or create a bookmark whose URL is the content of `dist/bookmarklet.txt`.
2. Click it on a Google results page.

`href` becomes the destination URL, `ping` is removed, the token is kept in `data-goto-token` and the confidence in `data-goto-kind`. Nothing is drawn; a one-line summary goes to the console. Unresolved links are left untouched. New blocks are handled as they load; `window.__gotoRecover.stop()` disconnects the observer.

`dist/bookmarklet-domain-fallback.txt` (or `window.__gotoRecover.run({ domainFallback: true })`) also sends domain-only links to the site root, marked `data-goto-kind="domain"`. That is not the page Google would open.

Build with `npm install && npm run build`.
