const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.PUBLIC_VENDOR_ADAPTER_API_KEY || process.env.ADAPTER_API_KEY || "";

const DEFAULT_HEADERS = {
  "user-agent":
    process.env.PUBLIC_VENDOR_ADAPTER_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  pragma: "no-cache",
  "cache-control": "no-cache"
};

const VENDORS = {
  automationdirect: {
    displayName: "AutomationDirect",
    domains: ["automationdirect.com"],
    searchUrls: (part) => [
      `https://www.automationdirect.com/adc/search/search?query=${encodeURIComponent(part)}`,
      `https://www.automationdirect.com/adc/shopping/search?term=${encodeURIComponent(part)}`
    ]
  },
  zoro: {
    displayName: "Zoro",
    domains: ["zoro.com"],
    searchUrls: (part) => [`https://www.zoro.com/search?q=${encodeURIComponent(part)}`]
  },
  grainger: {
    displayName: "Grainger",
    domains: ["grainger.com"],
    searchUrls: (part) => [`https://www.grainger.com/search?searchQuery=${encodeURIComponent(part)}`]
  },
  homedepot: {
    displayName: "Home Depot",
    domains: ["homedepot.com"],
    searchUrls: (part) => [`https://www.homedepot.com/s/${encodeURIComponent(part)}`]
  },
  amazon: {
    displayName: "Amazon",
    domains: ["amazon.com"],
    searchUrls: (part) => [`https://www.amazon.com/s?k=${encodeURIComponent(part)}`]
  },
  jme: {
    displayName: "JME Ellsworth",
    domains: ["jmesales.com"],
    searchUrls: (part) => [`https://www.jmesales.com/search.php?search_query=${encodeURIComponent(part)}`]
  },
  commercialindsupply: {
    displayName: "Commercial Ind. Supply",
    domains: ["commercialindsupply.com"],
    searchUrls: (part) => [
      `https://commercialindsupply.com/search.php?search_query=${encodeURIComponent(part)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(`site:commercialindsupply.com ${part}`)}`
    ]
  },
  wicvalve: {
    displayName: "WIC Valve",
    domains: ["wicvalve.com"],
    searchUrls: (part) => [
      `https://www.bing.com/search?q=${encodeURIComponent(`site:wicvalve.com ${part}`)}`
    ]
  },
  geminivalve: {
    displayName: "Gemini Valve",
    domains: ["geminivalve.com"],
    searchUrls: (part) => [
      `https://www.bing.com/search?q=${encodeURIComponent(`site:geminivalve.com ${part}`)}`
    ]
  },
  sourcenorthamerica: {
    displayName: "Source North America Corp",
    domains: ["sourcenorthamerica.com"],
    searchUrls: (part) => [
      `https://www.bing.com/search?q=${encodeURIComponent(`site:sourcenorthamerica.com ${part}`)}`
    ]
  }
};

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "public-vendor-adapter",
    endpoints: ["/", "/health", "/vendor/product"],
    vendors: Object.keys(VENDORS)
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "public-vendor-adapter",
    hasApiKey: Boolean(API_KEY),
    vendors: Object.keys(VENDORS)
  });
});

app.post("/vendor/product", async (req, res) => {
  try {
    requireApiKey(req);

    const vendorKey = normalizeVendorKey(req.body?.vendorKey);
    const vendorPartNumber = String(req.body?.vendorPartNumber || "").trim();
    const includePrice = req.body?.includePrice !== false;

    if (!vendorKey) {
      return res.status(400).json({ ok: false, error: "vendorKey is required" });
    }

    if (!vendorPartNumber) {
      return res.status(400).json({ ok: false, error: "vendorPartNumber is required" });
    }

    const vendor = VENDORS[vendorKey];
    if (!vendor) {
      return res.status(400).json({ ok: false, error: `Unsupported vendorKey: ${vendorKey}` });
    }

    const result = await lookupVendorProduct(vendorKey, vendorPartNumber, includePrice);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`public-vendor-adapter listening on ${PORT}`);
});

function requireApiKey(req) {
  if (!API_KEY) {
    throw new Error("PUBLIC_VENDOR_ADAPTER_API_KEY is not configured on the server");
  }

  const incoming = String(req.get("x-api-key") || "").trim();
  if (!incoming || incoming !== API_KEY) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function normalizeVendorKey(value) {
  const raw = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  const aliasMap = {
    "automation direct": "automationdirect",
    automationdirect: "automationdirect",
    zoro: "zoro",
    grainger: "grainger",
    "home depot": "homedepot",
    homedepot: "homedepot",
    amazon: "amazon",
    jme: "jme",
    "jme ellsworth": "jme",
    ellsworth: "jme",
    "commercial ind. supply": "commercialindsupply",
    commercialindsupply: "commercialindsupply",
    "wic valve": "wicvalve",
    wicvalve: "wicvalve",
    "gemini valve": "geminivalve",
    geminivalve: "geminivalve",
    "source north america corp": "sourcenorthamerica",
    sourcenorthamerica: "sourcenorthamerica"
  };

  return aliasMap[raw] || raw.replace(/\s+/g, "");
}

async function lookupVendorProduct(vendorKey, vendorPartNumber, includePrice) {
  const vendor = VENDORS[vendorKey];
  const searchUrls = vendor.searchUrls(vendorPartNumber);
  const normalizedRequested = normalizePart(vendorPartNumber);
  const attempts = [];

  for (const searchUrl of searchUrls) {
    try {
      const searchPage = await fetchHtml(searchUrl);
      const candidateUrls = extractCandidateUrls(vendorKey, searchPage.url, searchPage.html, vendorPartNumber);

      for (const candidateUrl of candidateUrls.slice(0, 8)) {
        try {
          const productPage = await fetchHtml(candidateUrl);
          const parsed = parseProductPage(vendorKey, productPage.url, productPage.html, vendorPartNumber);

          if (!parsed) {
            attempts.push({ targetUrl: candidateUrl, error: "parseProductPage returned null" });
            continue;
          }

          if (includePrice && (!Number.isFinite(parsed.unitCost) || parsed.unitCost <= 0)) {
            attempts.push({ targetUrl: candidateUrl, error: `invalid non-positive unitCost: ${parsed.unitCost}` });
            continue;
          }

          const resolvedVendorPartNo = normalizePart(
            parsed.resolvedVendorPartNo ||
              parsed.vendorPartNumber ||
              extractPartFromUrl(productPage.url) ||
              vendorPartNumber
          );

          const resolvedOk = resolvedVendorPartNo === normalizedRequested || resolvedVendorPartNo.includes(normalizedRequested) || normalizedRequested.includes(resolvedVendorPartNo);
          if (!resolvedOk) {
            attempts.push({
              targetUrl: candidateUrl,
              error: `resolved part mismatch: requested ${normalizedRequested}, got ${resolvedVendorPartNo}`
            });
            continue;
          }

          return {
            ok: true,
            vendorKey,
            resolvedVendorPartNo,
            item: {
              unitCost: parsed.unitCost,
              description: parsed.description,
              productUrl: productPage.url,
              imageUrl: parsed.imageUrl || null,
              unitOfMeasure: parsed.unitOfMeasure || null,
              source: parsed.source || `${vendorKey}_scrape`
            }
          };
        } catch (error) {
          attempts.push({
            targetUrl: candidateUrl,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      attempts.push({
        targetUrl: searchUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw new Error(
    `Lookup failed for ${vendor.displayName} ${vendorPartNumber}. Attempts: ${attempts
      .map((a) => `${a.targetUrl} -> ${a.error}`)
      .join(" | ")}`
  );
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: DEFAULT_HEADERS,
    redirect: "follow"
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (/captcha|access denied|robot check|are you a robot|verify you are human/i.test(html)) {
    throw new Error("Vendor blocked the request with anti-bot or verification page");
  }

  return {
    url: response.url || url,
    html
  };
}

function extractCandidateUrls(vendorKey, pageUrl, html, vendorPartNumber) {
  const vendor = VENDORS[vendorKey];
  const requested = normalizePart(vendorPartNumber);
  const $ = cheerio.load(html);
  const candidates = [];

  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    const text = cleanText($(el).text());
    const title = cleanText($(el).attr("title") || "");
    const joined = `${text} ${title}`.trim();

    if (!href) return;

    const absolute = absolutizeUrl(pageUrl, href);
    if (!absolute) return;

    const upperAbsolute = absolute.toUpperCase();
    const upperJoined = normalizePart(joined);

    let score = 0;

    if (upperAbsolute.includes(requested)) score += 100;
    if (upperJoined.includes(requested)) score += 80;
    if (text && /product|item|details/i.test(text)) score += 10;
    if (/\/p\/|\/product|\/products|\/item|\/itm\//i.test(absolute)) score += 25;
    if (/\/s\//i.test(absolute) && vendorKey === "homedepot") score += 10;
    if (/\/dp\//i.test(absolute) && vendorKey === "amazon") score += 40;
    if (/search|query=|k=|searchQuery=/i.test(absolute)) score -= 20;

    if (!vendor.domains.some((d) => absolute.includes(d))) return;
    if (score <= 0) return;

    candidates.push({ url: absolute, score });
  });

  return uniqueBy(
    candidates
      .sort((a, b) => b.score - a.score)
      .map((x) => x.url),
    (x) => x
  );
}

function parseProductPage(vendorKey, pageUrl, html, vendorPartNumber) {
  const $ = cheerio.load(html);
  const jsonLd = extractJsonLd($);
  const metaPrice = firstNonEmpty(
    $("meta[property='product:price:amount']").attr("content"),
    $("meta[itemprop='price']").attr("content"),
    $("meta[name='twitter:data1']").attr("content")
  );

  const title = firstNonEmpty(
    $("meta[property='og:title']").attr("content"),
    $("h1").first().text(),
    $("title").text()
  );

  const description = firstNonEmpty(
    $("meta[name='description']").attr("content"),
    $("meta[property='og:description']").attr("content"),
    title
  );

  const imageUrl = absolutizeUrl(
    pageUrl,
    firstNonEmpty(
      $("meta[property='og:image']").attr("content"),
      $("img[itemprop='image']").attr("src"),
      $("img").filter((_, img) => /product|hero|primary/i.test(String($(img).attr("class") || ""))).first().attr("src")
    )
  );

  const unitOfMeasure = detectUnitOfMeasure($, jsonLd);
  const resolvedVendorPartNo = detectResolvedPartNumber(pageUrl, $, jsonLd, vendorPartNumber, vendorKey);
  const unitCost = detectUnitCost($, jsonLd, metaPrice, vendorKey);

  return {
    unitCost,
    description: cleanText(description),
    imageUrl,
    unitOfMeasure,
    resolvedVendorPartNo,
    source: `${vendorKey}_scrape`
  };
}

function detectUnitCost($, jsonLd, metaPrice, vendorKey) {
  const prices = [];

  pushPrice(prices, metaPrice);

  for (const obj of jsonLd) {
    collectPricesFromJson(prices, obj);
  }

  const selectors = [
    "[itemprop='price']",
    ".price",
    ".product-price",
    ".priceToPay",
    ".a-price .a-offscreen",
    ".price-characteristic",
    ".pricing",
    "[data-testid='price']"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      pushPrice(prices, $(el).attr("content"));
      pushPrice(prices, $(el).text());
    });
  }

  const bodyText = cleanText($("body").text()).slice(0, 12000);
  const regex = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g;
  let match;
  while ((match = regex.exec(bodyText)) !== null) {
    pushPrice(prices, match[0]);
  }

  const filtered = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (!filtered.length) return null;

  if (vendorKey === "amazon") {
    return filtered.find((p) => p >= 0.01) ?? filtered[0];
  }

  return filtered[0];
}

function detectUnitOfMeasure($, jsonLd) {
  const direct = firstNonEmpty(
    $("[itemprop='unitCode']").attr("content"),
    $(".uom").first().text(),
    $(".unit-of-measure").first().text()
  );

  if (direct) return cleanText(direct);

  for (const obj of jsonLd) {
    if (obj && typeof obj === "object") {
      if (obj.unitCode) return String(obj.unitCode);
      if (obj.offers?.priceSpecification?.referenceQuantity?.unitCode) {
        return String(obj.offers.priceSpecification.referenceQuantity.unitCode);
      }
    }
  }

  return "Each";
}

function detectResolvedPartNumber(pageUrl, $, jsonLd, vendorPartNumber, vendorKey) {
  const requested = normalizePart(vendorPartNumber);
  const candidates = [];

  candidates.push(extractPartFromUrl(pageUrl));
  candidates.push($("meta[name='sku']").attr("content"));
  candidates.push($("[itemprop='sku']").attr("content"));
  candidates.push($("[data-testid='product-sku']").text());
  candidates.push($("body").text());

  for (const obj of jsonLd) {
    if (obj && typeof obj === "object") {
      candidates.push(obj.sku);
      candidates.push(obj.mpn);
      if (obj.productID) candidates.push(obj.productID);
      if (obj.offers?.sku) candidates.push(obj.offers.sku);
    }
  }

  for (const raw of candidates) {
    const text = normalizePart(raw);
    if (!text) continue;
    if (text === requested) return text;
    if (text.includes(requested)) return requested;
  }

  const pageText = normalizePart($("body").text()).slice(0, 40000);
  if (pageText.includes(requested)) return requested;

  return extractPartFromUrl(pageUrl) || requested || vendorPartNumber || vendorKey;
}

function extractJsonLd($) {
  const out = [];

  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
      // ignore bad json-ld blocks
    }
  });

  return out;
}

function collectPricesFromJson(prices, obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.price) pushPrice(prices, obj.price);
  if (obj.lowPrice) pushPrice(prices, obj.lowPrice);
  if (obj.highPrice) pushPrice(prices, obj.highPrice);

  if (obj.offers) {
    if (Array.isArray(obj.offers)) {
      for (const offer of obj.offers) collectPricesFromJson(prices, offer);
    } else {
      collectPricesFromJson(prices, obj.offers);
    }
  }

  if (obj.priceSpecification) {
    collectPricesFromJson(prices, obj.priceSpecification);
  }
}

function pushPrice(list, raw) {
  const parsed = parsePrice(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    list.push(parsed);
  }
}

function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/,/g, " ");
  const match = text.match(/([0-9]+(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function absolutizeUrl(pageUrl, maybeRelative) {
  const href = String(maybeRelative || "").trim();
  if (!href) return null;
  if (href.startsWith("javascript:")) return null;
  if (href.startsWith("mailto:")) return null;
  if (href.startsWith("tel:")) return null;

  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function extractPartFromUrl(url) {
  const clean = String(url || "").toUpperCase();
  const match = clean.match(/\/([0-9A-Z._-]{3,})\/?(?:\?|#|$)/);
  if (!match?.[1]) return null;
  return normalizePart(match[1]);
}

function normalizePart(value) {
  return String(value || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/\/+$/g, "");
}
