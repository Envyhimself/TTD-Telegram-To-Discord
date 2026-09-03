import { parse } from 'node-html-parser';

import { CHANNELS } from './channels.js';

export { CHANNELS };

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractBackgroundUrl(style) {
  if (!style) return null;
  const m = style.match(/background-image:\s*url\(['"]?(.*?)['"]?\)/i);
  return m && m[1] ? m[1] : null;
}

export function extractImages(node) {
  const images = [];
  for (const photo of node.querySelectorAll('.tgme_widget_message_photo_wrap')) {
    const u = extractBackgroundUrl(photo.getAttribute('style'));
    if (u) images.push(u);
  }
  // Only use video thumbnails when Telegram does not expose a playable video.
  if (node.querySelectorAll('video[src]').length === 0) {
    for (const vt of node.querySelectorAll('.tgme_widget_message_video_thumb')) {
      const u = extractBackgroundUrl(vt.getAttribute('style'));
      if (u) images.push(u);
    }
    for (const v of node.querySelectorAll('video[poster]')) {
      const u = v.getAttribute('poster');
      if (u) images.push(u);
    }
  }
  return [...new Set(images)];
}

export function extractVideos(node) {
  const videos = [];
  for (const video of node.querySelectorAll('video[src]')) {
    const url = video.getAttribute('src');
    const poster = video.getAttribute('poster') || null;
    if (url) videos.push({ url, poster });
  }
  return videos.filter((v, i, all) => all.findIndex(x => x.url === v.url) === i);
}

// Convert Telegram preview HTML into clean Discord markdown.
// selfHandle: the channel's own handle — self-signature links are dropped.
export function htmlToDiscord(html, selfHandle = '') {
  if (!html) return '';
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  // Discord has no underline markdown; '__' would render as strikethrough. Drop it.
  s = s.replace(/<u>([\s\S]*?)<\/u>/gi, '$1');
  s = s.replace(/<blockquote[^>]*>/gi, '\n> ');
  s = s.replace(/<\/blockquote>/gi, '\n');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
    const t = txt.replace(/<[^>]*>/g, '').replace(/\*/g, '').trim();
    if (!t) return '';
    // Self-signature link (e.g. "@WarRoom" at end of its own posts) — drop it.
    // Telegram link text may carry nbsp/extra spaces, so compare whitespace-stripped.
    if (selfHandle && t.replace(/\s+/g, '').toLowerCase() === ('@' + selfHandle).toLowerCase()) return '';
    // Relative/search hrefs (Telegram hashtags like "?q=%23fari") are dead in Discord — keep the text.
    if (!/^https?:\/\//i.test(href)) return t;
    if (t === href) return href;
    return `[${t}](${href})`;
  });
  s = s.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
       .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  s = s.replace(/[\u00a0\u2000-\u200b]/g, ' '); // nbsp & other unicode spaces (incl. from &#160;)
  s = s.replace(/\*\*\*\*/g, '');
  // Un-bold emoji-only segments: Discord renders **😍** as literal asterisks.
  s = s.replace(/\*\*((?:[\p{Extended_Pictographic}\uFE0F\u200D\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF\u2300-\u23FF\s])+)\*\*/gu, '$1');
  s = s.replace(/\*\*\s*\*\*/g, '');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  // Drop consecutive duplicate lines (channels often paste the same link twice).
  s = s.split('\n').reduce((acc, line) => {
    if (line.trim() && acc.length && acc[acc.length - 1] === line) return acc;
    acc.push(line);
    return acc;
  }, []).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Fetch and parse a channel's public preview page. Returns messages sorted ascending.
export async function fetchChannelMessages(handle) {
  const res = await fetch(`https://t.me/s/${handle}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Telegram: HTTP ${res.status}`);
  }
  const root = parse(await res.text());
  const nodes = root.querySelectorAll('.js-widget_message');
  const messages = [];
  for (const node of nodes) {
    const postAttr = node.getAttribute('data-post');
    if (!postAttr) continue;
    const id = parseInt(postAttr.split('/')[1], 10);
    if (isNaN(id)) continue;
    const textNode = node.querySelector('.tgme_widget_message_text') || node.querySelector('.js-message_text');
    const text = textNode ? htmlToDiscord(textNode.innerHTML || '', handle) : '';
    const images = extractImages(node);
    const videos = extractVideos(node);
    messages.push({ id, text, images, videos, hasContent: !!(text || images.length || videos.length) });
  }
  messages.sort((a, b) => a.id - b.id);
  return messages;
}

export function findChannel(handle) {
  return CHANNELS.find(c => c.handle === handle) || null;
}
