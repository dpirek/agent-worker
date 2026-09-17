import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownHtml } from '../public/lib/markdown-parser.mjs';

test('renders chat formatting, code, quotes, and line breaks', () => {
  const html = markdownHtml('# Heading\n\n**bold** and *italic* and ~~gone~~\nnext\n\n> quote\n\n```js\n<img onerror="bad()">\n```');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong> and <em>italic<\/em> and <del>gone<\/del><br>next/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>&lt;img onerror=&quot;bad\(\)&quot;&gt;\n<\/code><\/pre>/);
  assert.equal(markdownHtml(null), '');
  assert.equal(markdownHtml('**a** *b*'), '<p><strong>a</strong> <em>b</em></p>');
});

test('renders nested lists, disabled tasks, ordered starts, and tables', () => {
  const html = markdownHtml('- [x] Done\n  - Nested\n- [ ] Pending\n\n3. Third\n4. Fourth\n\n| Name | Value |\n| :--- | ---: |\n| **Item** | 42 |');
  assert.match(html, /<input type="checkbox" disabled checked><p>Done<\/p><ul><li><p>Nested/);
  assert.match(html, /<input type="checkbox" disabled><p>Pending/);
  assert.match(html, /<ol start="3"><li><p>Third/);
  assert.match(html, /<th align="right">Value<\/th>/);
  assert.match(html, /<td align="left"><strong>Item<\/strong><\/td><td align="right">42<\/td>/);
});

test('keeps links, images, titles, and bare workspace URLs', () => {
  const html = markdownHtml('[report](http://localhost:8100/workspace/a.pdf "Read it")\n![plot](/workspace/plot.png)\nhttps://example.com/a_(b).\n`https://example.com`');
  assert.match(html, /href="http:\/\/localhost:8100\/workspace\/a.pdf" title="Read it"/);
  assert.match(html, /<img src="\/workspace\/plot.png" alt="plot">/);
  assert.match(html, /href="https:\/\/example.com\/a_\(b\)"/);
  assert.match(html, /<code>https:\/\/example.com<\/code>/);
});

test('treats raw HTML as text and prevents executable URL and attribute injection', () => {
  for (const input of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>']) {
    const html = markdownHtml(input);
    assert.ok(!html.includes(input));
    assert.match(html, /&lt;/);
  }
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,bad', 'vbscript:bad', 'java&#x73;cript:bad', 'javascript&#58;bad']) {
    const html = markdownHtml(`[click](${url}) ![image](${url})`);
    assert.doesNotMatch(html, /(?:href|src)="(?:javascript:|data:|vbscript:)/i);
    assert.doesNotMatch(html, /&#x73;|&#58;/);
  }
  assert.equal(markdownHtml('![x](<https://example.com/"onerror="bad>)'), '<p><img src="https://example.com/&quot;onerror=&quot;bad" alt="x"></p>');
  assert.match(markdownHtml('[x](<java\nscript:alert(1)>)'), /\[x\]/);
});

test('handles unclosed fences and deeply nested markup without recursion failures', () => {
  assert.equal(markdownHtml('```\n**literal**'), '<pre><code>**literal**\n</code></pre>');
  assert.doesNotThrow(() => markdownHtml('> '.repeat(1000) + 'text'));
  assert.equal(markdownHtml('snake_case_name'), '<p>snake_case_name</p>');
});
