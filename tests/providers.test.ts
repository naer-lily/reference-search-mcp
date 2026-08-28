import { describe, expect, it } from "vitest";
import { extractVqd, parseDdgJson } from "../src/providers/ddg.js";
import { parseBingHtml } from "../src/providers/bing.js";
import { parseWikimediaJson } from "../src/providers/wikimedia.js";

describe("ddg", () => {
  it("extracts vqd from html", () => {
    expect(extractVqd(`<html>var vqd='12345-abc';</html>`)).toBe("12345-abc");
    expect(extractVqd(`<html>vqd="67890"</html>`)).toBe("67890");
    expect(extractVqd(`<html>no token</html>`)).toBeNull();
  });

  it("extracts vqd from real-page-shaped html (script var + hidden input)", () => {
    const html =
      `<html><head><script>const vqd='3-1234567890123456789012345678901234567890';</script></head>` +
      `<body><form><input type="hidden" name="vqd" value="4-abcdef-9876543210"></form></body></html>`;
    expect(extractVqd(html)).toBe("3-1234567890123456789012345678901234567890");
  });

  it("maps i.js results", () => {
    const out = parseDdgJson(
      {
        results: [
          { image: "https://ex.com/full.jpg", thumbnail: "https://ex.com/thumb.jpg", title: "A cat", url: "https://www.example.com/page", width: 800, height: 600 },
          { image: "https://ex.com/no-thumb.jpg" },
          { image: "https://ex.com/second.jpg", thumbnail: "https://ex.com/t2.jpg" },
        ],
      },
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      thumbUrl: "https://ex.com/thumb.jpg",
      fullUrl: "https://ex.com/full.jpg",
      title: "A cat",
      sourceDomain: "example.com",
      provider: "ddg",
      width: 800,
      height: 600,
    });
  });

  it("respects max", () => {
    const out = parseDdgJson(
      {
        results: [
          { image: "a.jpg", thumbnail: "a-t.jpg" },
          { image: "b.jpg", thumbnail: "b-t.jpg" },
        ],
      },
      1,
    );
    expect(out).toHaveLength(1);
  });
});

describe("bing", () => {
  const html =
    `<a class="iusc" m="{&quot;murl&quot;:&quot;https://x.com/a.jpg&quot;,&quot;turl&quot;:&quot;https://x.com/a-t.jpg&quot;,&quot;t&quot;:&quot;Hello \\&quot;World\\&quot;&quot;,&quot;pur&quot;:&quot;https://www.x.com/p&quot;,&quot;mw&quot;:1024,&quot;mh&quot;:768}"></a>` +
    `<a class="iusc" m="{&quot;murl&quot;:&quot;https://x.com/b.jpg&quot;,&quot;turl&quot;:&quot;https://x.com/b-t.jpg&quot;}"></a>` +
    `<a class="iusc" m="{not json}"></a>`;

  it("parses m= json blocks", () => {
    const out = parseBingHtml(html, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ thumbUrl: "https://x.com/a-t.jpg", fullUrl: "https://x.com/a.jpg", sourceDomain: "x.com", width: 1024, height: 768 });
    expect(out[0].title).toBe('Hello "World"');
  });

  it("respects max", () => {
    expect(parseBingHtml(html, 1)).toHaveLength(1);
  });
});

describe("wikimedia", () => {
  const json = {
    query: {
      pages: {
        "1": {
          title: "File:Nebula.jpg",
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Nebula.jpg",
              thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Nebula.jpg/300px-Nebula.jpg",
              width: 2000,
              height: 1000,
              extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } },
            },
          ],
        },
        "2": { title: "File:No-thumb.jpg" },
        "3": { title: "File:Second.jpg", imageinfo: [{ url: "https://u.wikimedia.org/2.jpg", thumburl: "https://u.wikimedia.org/2-t.jpg" }] },
      },
    },
  };

  it("maps pages with license", () => {
    const out = parseWikimediaJson(json as never, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      fullUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Nebula.jpg",
      thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Nebula.jpg/300px-Nebula.jpg",
      license: "CC BY-SA 4.0",
      sourceDomain: "commons.wikimedia.org",
      provider: "wikimedia",
      width: 2000,
      height: 1000,
    });
  });
});
