import { describe, it, expect } from 'vitest';
import { parseFeed } from '../src/ingest/parseFeed.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Magazine</title>
    <link>https://example.com</link>
    <description>Things worth reading</description>
    <language>en-us</language>
    <item>
      <title>How Bridges Actually Stay Up</title>
      <link>https://example.com/bridges?utm_source=rss</link>
      <guid isPermaLink="false">tag:example.com,2024:1234</guid>
      <pubDate>Mon, 04 Nov 2024 10:00:00 GMT</pubDate>
      <dc:creator>Jane Roe</dc:creator>
      <description><![CDATA[<p>A <b>surprising</b> explanation of tension.</p>]]></description>
      <content:encoded><![CDATA[<p>Full body text here.</p>]]></content:encoded>
      <category>engineering</category>
      <category>infrastructure</category>
    </item>
    <item>
      <title>Second Story</title>
      <link>https://example.com/second</link>
      <pubDate>2024-11-03 09:30:00</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title>Simon's Blog</title>
  <link rel="self" href="https://blog.example/atom"/>
  <link rel="alternate" type="text/html" href="https://blog.example/"/>
  <entry>
    <title>Notes on agents</title>
    <link rel="alternate" type="text/html" href="https://blog.example/agents"/>
    <link rel="enclosure" type="audio/mpeg" href="https://blog.example/agents.mp3" length="4200"/>
    <id>https://blog.example/agents</id>
    <published>2024-11-04T08:00:00Z</published>
    <author><name>Simon</name></author>
    <summary>Short summary.</summary>
    <content type="html">&lt;p&gt;Long content&lt;/p&gt;</content>
    <category term="ai"/>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Old School</title><link>https://old.example</link></channel>
  <item rdf:about="https://old.example/a">
    <title>An RDF item</title>
    <link>https://old.example/a</link>
    <dc:date>2024-11-01T12:00:00+01:00</dc:date>
    <dc:creator>Someone</dc:creator>
    <description>Body</description>
  </item>
</rdf:RDF>`;

const PODCAST = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Show</title>
    <link>https://show.example</link>
    <itunes:author>The Host</itunes:author>
    <itunes:summary>A podcast</itunes:summary>
    <item>
      <title>Episode 12: On Cities</title>
      <link>https://show.example/12</link>
      <enclosure url="https://cdn.show.example/12.mp3" type="audio/mpeg" length="50000000"/>
      <itunes:duration>42:10</itunes:duration>
      <pubDate>Tue, 05 Nov 2024 06:00:00 +0000</pubDate>
      <description>We discuss how cities work, referencing https://example.com/bridges</description>
    </item>
    <item>
      <title>Episode 11</title>
      <link>https://show.example/11</link>
      <enclosure url="https://cdn.show.example/11.mp3" type="audio/mpeg"/>
      <itunes:duration>3600</itunes:duration>
    </item>
  </channel>
</rss>`;

describe('parseFeed: RSS', () => {
  const feed = parseFeed(RSS);

  it('identifies the format and channel metadata', () => {
    expect(feed.kind).toBe('rss');
    expect(feed.title).toBe('Example Magazine');
    expect(feed.siteUrl).toBe('https://example.com');
    expect(feed.language).toBe('en-us');
    expect(feed.isPodcast).toBe(false);
  });

  it('extracts items with all the fields we persist', () => {
    expect(feed.items).toHaveLength(2);
    const first = feed.items[0]!;
    expect(first.title).toBe('How Bridges Actually Stay Up');
    expect(first.link).toBe('https://example.com/bridges?utm_source=rss');
    expect(first.guid).toBe('tag:example.com,2024:1234');
    expect(first.author).toBe('Jane Roe');
    expect(first.publishedAt).toBe(Date.parse('2024-11-04T10:00:00Z'));
    expect(first.summary).toContain('surprising');
    expect(first.content).toContain('Full body text');
    expect(first.categories).toEqual(['engineering', 'infrastructure']);
  });

  it('parses non-standard date formats', () => {
    expect(feed.items[1]!.publishedAt).toBe(Date.UTC(2024, 10, 3, 9, 30, 0));
  });
});

describe('parseFeed: publisher images', () => {
  it('keeps editorial images from media, enclosures and full-content HTML', () => {
    const feed = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"
           xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel><title>Illustrated</title><link>https://example.com</link><item>
          <title>An illustrated English article about a surprising new machine</title>
          <link>https://example.com/posts/machine</link>
          <media:content url="https://cdn.example.com/hero.jpg" type="image/jpeg" width="1200" height="800">
            <media:title>The machine at work</media:title>
            <media:description>A field test</media:description>
          </media:content>
          <enclosure url="https://cdn.example.com/detail.webp" type="image/webp"/>
          <content:encoded><![CDATA[
            <p>Full article.</p>
            <img src="/images/diagram.png" alt="How the mechanism fits together" width="900" height="600">
            <img src="https://example.com/tracking/pixel.gif" width="1" height="1">
          ]]></content:encoded>
        </item></channel>
      </rss>`);

    expect(feed.items[0]!.images).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/hero.jpg',
        alt: 'The machine at work',
        caption: 'A field test',
        width: 1200,
        height: 800,
        source: 'media',
      }),
      expect.objectContaining({ url: 'https://cdn.example.com/detail.webp', source: 'enclosure' }),
      expect.objectContaining({
        url: 'https://example.com/images/diagram.png',
        alt: 'How the mechanism fits together',
        source: 'feed_content',
      }),
    ]);
    expect(feed.items[0]!.images.some((image) => image.url.includes('tracking'))).toBe(false);
  });
});

describe('parseFeed: Atom', () => {
  const feed = parseFeed(ATOM, 'https://blog.example/atom');

  it('handles a leading stylesheet instruction and rel=alternate links', () => {
    expect(feed.kind).toBe('atom');
    expect(feed.items[0]!.link).toBe('https://blog.example/agents');
  });

  it('reads nested author names and enclosure links', () => {
    const entry = feed.items[0]!;
    expect(entry.author).toBe('Simon');
    expect(entry.enclosure?.url).toBe('https://blog.example/agents.mp3');
    expect(entry.enclosure?.type).toBe('audio/mpeg');
    expect(entry.categories).toEqual(['ai']);
  });
});

describe('parseFeed: RDF', () => {
  it('handles RSS 1.0 documents', () => {
    const feed = parseFeed(RDF);
    expect(feed.kind).toBe('rdf');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.title).toBe('An RDF item');
    expect(feed.items[0]!.publishedAt).toBe(Date.parse('2024-11-01T12:00:00+01:00'));
  });
});

describe('parseFeed: podcast', () => {
  const feed = parseFeed(PODCAST);

  it('detects podcast feeds', () => {
    expect(feed.isPodcast).toBe(true);
  });

  it('parses durations in both formats', () => {
    expect(feed.items[0]!.durationMinutes).toBe(42);
    expect(feed.items[1]!.durationMinutes).toBe(60);
  });
});

describe('parseFeed: malformed input', () => {
  it('never throws', () => {
    const inputs = [
      '',
      '   ',
      'not xml at all',
      '<rss><channel><item><title>Unclosed',
      '<?xml version="1.0"?><html><body>Nope</body></html>',
      '﻿<?xml version="1.0"?><rss version="2.0"><channel><title>BOM</title></channel></rss>',
    ];
    for (const input of inputs) {
      expect(() => parseFeed(input)).not.toThrow();
    }
  });

  it('returns an empty feed rather than garbage for non-feeds', () => {
    const feed = parseFeed('<html><body><p>hello</p></body></html>');
    expect(feed.items).toEqual([]);
    expect(feed.kind).toBe('unknown');
  });

  it('handles a channel with exactly one item (not wrapped in an array)', () => {
    const feed = parseFeed(
      '<rss version="2.0"><channel><title>T</title><item><title>Only</title><link>https://a.com/x</link></item></channel></rss>',
    );
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.title).toBe('Only');
  });

  it('survives items missing every optional field', () => {
    const feed = parseFeed('<rss version="2.0"><channel><item><title>Bare</title></item></channel></rss>');
    expect(feed.items[0]).toMatchObject({ title: 'Bare', link: null, publishedAt: null, author: null });
  });

  it('strips HTML from titles', () => {
    const feed = parseFeed(
      '<rss version="2.0"><channel><item><title>A &amp;amp; B &lt;em&gt;emphasis&lt;/em&gt;</title><link>https://a.com/x</link></item></channel></rss>',
    );
    expect(feed.items[0]!.title).toBe('A & B emphasis');
  });
});
