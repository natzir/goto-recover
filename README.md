# goto-recover

Google Search serves signed-out users result links as `/goto?url=<token>`. The `href` no longer contains the destination, the token is an opaque protobuf, and the `ping` attribute carries the same token.

This repository documented where the destination still lived in the page and how to pair it with each link, so that SERP parsers could keep resolving results without a request to `/goto`.

> **Status, 21 September 2026: this no longer works for organic results.** Google stopped shipping their destination in the page. What is still in the page, and how to resolve a token with one `GET` (redirect not followed), come first. There is also a way that needs no `GET`; see [Without the GET](#without-the-get). The original write-up is kept at the end as a record.

## What changed

- The `about-this-result?...&req=<base64url>` link is gone from the HTML. It was the `exact` source.
- The inline state `var m={...}` is still there, but organic records carry only the domain root.
- The `W_jd` jsdata store no longer holds external URLs. The uBlock Origin scriptlet that un-wrapped these links (uAssets `privacy.txt`, also bundled by Brave) read it.

## What is left in the page

| Block | Destination in the page |
|---|---|
| YouTube videos and their key moments | full `watch?v=` URL in the record (`embedded`); key moments are `derived` from it |
| AI Overview sources | link-preview comment after the anchor (`adjacent`), or a full URL in the `/async/` payload (`embedded`) |
| Organic result that the AI Overview also cites | borrowed from that source by host and title (`inferred`) |
| Results on `*.google.com` | never wrapped; the `href` is the destination |
| Every other organic result, sitelinks, related results, shopping, ads | the domain root at most |

On an en-US results page for `best espresso machine`, the bookmarklet rewrote 25 of 87 `/goto` links, all of them YouTube videos or the page cited by the AI Overview. `resolve.js` paired 7 of 50 tokens. Of the 8 organic web results, the only one resolved was the one the AI Overview also cites.

## Resolving a token: one GET, redirect not followed

```
GET https://www.google.com/goto?url=<token>
302
Location: <destination>
```

```sh
curl -s -o /dev/null -w '%{redirect_url}\n' 'https://www.google.com/goto?url=<token>'
```

```js
const res = await fetch('https://www.google.com/goto?url=' + token, { redirect: 'manual' });
const url = res.headers.get('location');
```

The request ends at Google. The redirect is not followed, so the destination site is never contacted.

Measured on 21 September 2026 from one residential IP:

- `GET` only. `HEAD` answers `200` with no `Location`.
- No cookies, referer or browser needed. It works from a different client than the one that loaded the results page.
- `Location` is the URL Google would open, including parameters it adds, such as `srsltid` on merchant listings.
- Tokens issued 4 h 44 min earlier still resolved. No expiry found.
- About 50 to 70 ms per request. 503 requests with bursts of about 500 req/s from Node: every answer a `302`, no `429`, no `/sorry`. The limit was not reached.
- The token cannot be resolved offline. It is encrypted (`08 01 12 <len>`, then a Tink-style prefix `01 eb3b3015` and the ciphertext) and not deterministic: the same URL gets a different token every time it appears, even within one page, so token-to-URL tables do not work. All it leaks is the length of the URL: the inner message is the URL length plus 56 bytes, 57 from 128 characters up.

### From inside Chrome

The same request can be fired from the results page itself, with the browser's own `fetch`:

```js
fetch('/goto?url=' + token, { redirect: 'manual', cache: 'no-store' });
```

Google did not throttle it either: 503 requests, up to 30 at a time, about 400 req/s, every answer a `302`. At that pace every link of a results page resolves in well under a second, without opening any of them.

Scripts in the page cannot read the answer: they get `type: "opaqueredirect"`, status `0` and no headers, so a bookmarklet cannot use this. The `Location` has to be read from outside the page:

- the DevTools Protocol (Puppeteer, Playwright, chrome-devtools-mcp): the `302` response of each `/goto` request carries the `location` header;
- an extension: `webRequest.onHeadersReceived` sees the same header.

## Without the GET

There is another way to get the destinations of a results page, with no request per link. It is not published here. If you are interested, contact me: [@natzir](https://github.com/natzir).

## Ruled out in the page

- Attributes of the `<a>` and its ancestors. `ping` holds the same token.
- Hover, pointer, context menu, focus and keyboard events: the `href` is never rewritten.
- JS state, storage and a full heap snapshot, searched for known destinations. Every response of the page load, including the AI Overview `/async/` payload.
- "About this result" (host only), Share (`share.google/<id>`, another redirect), "Translate this page" (now a `/goto` link itself).
- Speculation rules. The page asks Chrome to prefetch the first two `/goto` links. That is the same `GET`, sent by the browser, and unlike the request above it goes on to download the destination page. Scripts in the page cannot read its result.

Not tested: signed-in sessions.

## How it worked until September 2026

Kept as a record. The rules still run, and they still pair what the table above lists.

### Where the destination lived

| Block | Token | Destination |
|---|---|---|
| Organic and video results | inline state `var m={...}` in a `<script>` | `about-this-result?...&req=<base64url>` in the same record: an unencrypted protobuf whose field 1 is the URL |
| AI Overview sources | HTML comment `<!--MARKER\|\|\|[...]-->` | either a full URL string in the same record, or only the domain root; in the latter case the "Show all" chips are followed by a link-preview comment whose first element is the URL |
| People also ask | HTML comment payload | full URL in the same record |
| Related results | comment payload and inline state | domain root plus title; the URL comes from the organic record with the same host and title |
| YouTube key moments | HTML template inside the script | parent video URL plus `t=<data-time>` |
| Ads, shopping offers, short-video carousels, sitelinks | DOM only | not present |

The AI Overview is not in the initial HTML. It arrives in a separate `/async/` response (`_id:B2Jtyd` in the request) that the page inserts into the DOM. A pipeline that only fetches the search page will resolve organic results; feeding that response body too covers the AI Overview.

### Pairing rule

Each source (the `var m` object, each comment payload) is a tree. Walk it bottom-up; every node aggregates the `/goto` tokens, the candidate URLs and the first text strings found below it. A node holding exactly one distinct token is that result's record, and its best candidate wins:

1. `exact` – field 1 of a `req` protobuf. A bare domain root here is kept: home pages rank too
2. `embedded` – a complete URL string, not on a Google host, with a path or query. A bare root found as a string is a label, not a destination, and is demoted to `domain`
3. `adjacent` – the link-preview comment that directly follows an anchor, accepted only when its host matches the token's own record
4. `inferred` – a domain-only record borrows the URL of a record with the same host and title
5. `derived` – key moments: parent video URL plus `t=`
6. `domain` – only the domain is known

Nodes with two or more tokens are never paired. If the data does not isolate a token with its URL, the token stays unresolved.

#### Decoding `req`

```
base64url  -> bytes
bytes[0]   == 0x0a          field 1, length-delimited
bytes[1..] varint length
next N bytes                UTF-8 URL
```

#### Parsing

- `var m={` is followed by a JSON object; take the balanced `{...}` and `JSON.parse` it.
- Comment payloads are `MARKER|||[...]` with HTML-escaped JSON (`&quot;`, `&amp;`); unescape before parsing.
- The mapping relies on record structure, not on class names or array positions.

## Reference implementation: `resolve.js`

Node, no dependencies, no DOM, no requests. Takes the raw HTML of the search page and, optionally, the bodies of the `/async/` responses, and returns a map `token -> { url, kind, host }`. Since September 2026 that map covers only what is left in the page; the rest needs the `GET` above.

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

Runs the same rules in the browser and rewrites the links in place, so the result can be checked on a real page. Since September 2026 it rewrites only what is left in the page, and it cannot fall back to the `GET`: a script in the page is not allowed to read that redirect.

1. Open `dist/index.html` and drag the button to your bookmarks bar, or create a bookmark whose URL is the content of `dist/bookmarklet.txt`.
2. Click it on a Google results page.

`href` becomes the destination URL, `ping` is removed, the token is kept in `data-goto-token` and the confidence in `data-goto-kind`. Nothing is drawn; a one-line summary goes to the console. Unresolved links are left untouched. New blocks are handled as they load; `window.__gotoRecover.stop()` disconnects the observer.

`dist/bookmarklet-domain-fallback.txt` (or `window.__gotoRecover.run({ domainFallback: true })`) also sends domain-only links to the site root, marked `data-goto-kind="domain"`. That is not the page Google would open.

Build with `npm install && npm run build`.
