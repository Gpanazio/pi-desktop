// The script injected into the browser panel's guest (every frame, every new
// document, in an isolated world the page cannot reach). It is plain ES5 text,
// not a function of this bundle, so a bundler cannot rewrite it on the way in.
// Two parts: the selector builder (also run by the tests, against a fake DOM)
// and the overlay (hover outline, click capture, numbered badges).

/** Name of the isolated world and of the binding the page calls back through. */
export const MARKS_WORLD = 'pi-browser-marks'
export const MARKS_BINDING = '__piMarksBinding'

/**
 * Selector for an element: [data-testid] when it is unique, then an id that is
 * unique, then the shortest tag path (with :nth-of-type where siblings share a
 * tag) that selects only it, anchored at the nearest ancestor with a unique
 * data-testid or id. `isUnique(selector)` tells whether a selector matches one
 * element in the document.
 */
export const SELECTOR_LIB = String.raw`
function piCssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_¡-￿-]/g, function (c) { return '\\' + c; }).replace(/^(\d)/, '\\3$1 ');
}
function piAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function piAnchorFor(el, isUnique) {
  var testid = el.getAttribute('data-testid');
  if (testid) {
    var byTestId = '[data-testid="' + piAttrValue(testid) + '"]';
    if (isUnique(byTestId)) return byTestId;
  }
  if (el.id) {
    var byId = '#' + piCssEscape(el.id);
    if (isUnique(byId)) return byId;
  }
  return null;
}
function piSegment(el) {
  var tag = el.tagName.toLowerCase();
  var parent = el.parentElement;
  if (!parent) return tag;
  var siblings = parent.children;
  var same = 0;
  var index = 0;
  for (var i = 0; i < siblings.length; i++) {
    if (siblings[i].tagName === el.tagName) {
      same++;
      if (siblings[i] === el) index = same;
    }
  }
  return same > 1 ? tag + ':nth-of-type(' + index + ')' : tag;
}
function piSelectorFor(el, isUnique) {
  if (el.tagName.toLowerCase() === 'html') return 'html';
  var own = piAnchorFor(el, isUnique);
  if (own) return own;
  var parts = [];
  var node = el;
  while (node && node.tagName) {
    if (node !== el) {
      var anchor = piAnchorFor(node, isUnique);
      if (anchor) {
        parts.unshift(anchor);
        return parts.join(' > ');
      }
    }
    parts.unshift(piSegment(node));
    var joined = parts.join(' > ');
    var tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || isUnique(joined)) return joined;
    node = node.parentElement;
  }
  return parts.join(' > ');
}
`

export const PAGE_SCRIPT = String.raw`(function () {
if (window.__piMarksApi) return;
var BINDING = '${MARKS_BINDING}';
var HIGHLIGHT = '#3b82f6';
var MARKED = '#f59e0b';
var isTop = window === window.top;
var mode = false;
var badges = [];
var hidden = false;
var host = null;
var root = null;
var hoverBox = null;
var hoverLabel = null;
var badgeLayer = null;
var cursorStyle = null;
var timer = null;
var frame = 0;
var cache = {};

${SELECTOR_LIB}

function send(message) {
  try {
    var fn = window[BINDING];
    if (typeof fn === 'function') fn(JSON.stringify(message));
  } catch (e) {}
}
function topHref() {
  try { return window.top.location.href; } catch (e) { return location.href; }
}
function uniqueIn(doc) {
  return function (selector) {
    try { return doc.querySelectorAll(selector).length === 1; } catch (e) { return false; }
  };
}
function frameChain() {
  var chain = [];
  var w = window;
  try {
    while (w !== w.parent && w.frameElement) {
      chain.unshift({ el: w.frameElement, doc: w.parent.document });
      w = w.parent;
    }
  } catch (e) {}
  return chain;
}
function frameOffset() {
  var x = 0, y = 0;
  var chain = frameChain();
  for (var i = 0; i < chain.length; i++) {
    var r = chain[i].el.getBoundingClientRect();
    x += r.left + chain[i].el.clientLeft;
    y += r.top + chain[i].el.clientTop;
  }
  return { x: x, y: y };
}
function fullSelector(el) {
  var parts = frameChain().map(function (link) { return piSelectorFor(link.el, uniqueIn(link.doc)); });
  parts.push(piSelectorFor(el, uniqueIn(el.ownerDocument)));
  return parts.join(' >>> ');
}
function resolve(selector) {
  var parts = String(selector).split(' >>> ');
  var doc = document;
  var offX = 0, offY = 0;
  try {
    for (var i = 0; i < parts.length - 1; i++) {
      var f = doc.querySelector(parts[i]);
      if (!f || !f.contentDocument) return null;
      var fr = f.getBoundingClientRect();
      offX += fr.left + f.clientLeft;
      offY += fr.top + f.clientTop;
      doc = f.contentDocument;
    }
    var el = doc.querySelector(parts[parts.length - 1]);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { el: el, rect: { x: r.left + offX, y: r.top + offY, width: r.width, height: r.height } };
  } catch (e) { return null; }
}
function ensureHost() {
  if (host && host.isConnected) return;
  host = document.createElement('div');
  host.setAttribute('data-pi-browser-overlay', '');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  root = host.attachShadow({ mode: 'closed' });
  hoverBox = document.createElement('div');
  hoverBox.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:2px solid ' + HIGHLIGHT + ';background:rgba(59,130,246,0.14);pointer-events:none;';
  hoverLabel = document.createElement('div');
  hoverLabel.style.cssText = 'position:fixed;display:none;padding:2px 6px;border-radius:4px;background:' + HIGHLIGHT + ';color:#fff;font:600 11px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap;pointer-events:none;';
  badgeLayer = document.createElement('div');
  root.appendChild(badgeLayer);
  root.appendChild(hoverBox);
  root.appendChild(hoverLabel);
  (document.documentElement || document).appendChild(host);
  host.style.display = hidden ? 'none' : '';
}
function describe(el, rect) {
  var label = el.tagName.toLowerCase();
  if (el.id) label += '#' + el.id;
  else if (typeof el.className === 'string' && el.className.trim() !== '') label += '.' + el.className.trim().split(/\s+/)[0];
  return label + '  ' + Math.round(rect.width) + '×' + Math.round(rect.height);
}
function showHover(el) {
  ensureHost();
  if (!el || el.tagName === 'IFRAME' || el.tagName === 'FRAME') { hoverBox.style.display = 'none'; hoverLabel.style.display = 'none'; return; }
  var r = el.getBoundingClientRect();
  hoverBox.style.cssText = 'position:fixed;display:block;box-sizing:border-box;border:2px solid ' + HIGHLIGHT + ';background:rgba(59,130,246,0.14);pointer-events:none;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
  hoverLabel.textContent = describe(el, r);
  var top = r.top >= 22 ? r.top - 22 : r.bottom + 2;
  hoverLabel.style.display = 'block';
  hoverLabel.style.left = Math.max(0, r.left) + 'px';
  hoverLabel.style.top = Math.max(0, top) + 'px';
}
function hideHover() {
  if (hoverBox) hoverBox.style.display = 'none';
  if (hoverLabel) hoverLabel.style.display = 'none';
}
function targetAt(e) {
  var el = document.elementFromPoint(e.clientX, e.clientY);
  return el && el !== host ? el : null;
}
function collapse(text, max) {
  var flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}
function pick(e) {
  var el = targetAt(e);
  if (!el) return;
  var r = el.getBoundingClientRect();
  var off = frameOffset();
  send({
    t: 'pick',
    shift: !!e.shiftKey,
    mark: {
      selector: fullSelector(el),
      text: collapse(el.innerText != null ? el.innerText : el.textContent, 200),
      html: collapse(el.outerHTML, 600),
      rect: { x: r.left + off.x, y: r.top + off.y, width: r.width, height: r.height },
      url: topHref()
    }
  });
}
function editable(el) {
  if (!el || !el.tagName) return false;
  var tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
var BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend'];
function onBlocked(e) {
  if (!mode) return;
  // A page's own el.click() must not forge a mark; only the user's input counts.
  if (!e.isTrusted) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click') pick(e);
}
function onMove(e) {
  if (!mode) return;
  showHover(targetAt(e));
}
function onKey(e) {
  if (!mode) return;
  var plainM = (e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target);
  if (e.key === 'Escape' || plainM) {
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ t: 'exit' });
  }
}
function layoutBadges() {
  frame = 0;
  if (!isTop || !badgeLayer) return;
  var visible = [];
  var href = topHref();
  for (var i = 0; i < badges.length; i++) {
    var b = badges[i];
    if (b.url !== href) continue;
    var found = null;
    var cached = cache[b.id];
    if (cached && cached.el.isConnected) {
      var cr = cached.el.getBoundingClientRect();
      if (b.selector.indexOf(' >>> ') === -1) found = { rect: { x: cr.left, y: cr.top, width: cr.width, height: cr.height } };
    }
    if (!found) {
      found = resolve(b.selector);
      if (found) cache[b.id] = found;
    }
    if (!found) continue;
    var r = found.rect;
    var o = b.sent ? 0.4 : 1;
    visible.push({ b: b, r: r, o: o });
  }
  while (badgeLayer.firstChild) badgeLayer.removeChild(badgeLayer.firstChild);
  for (var j = 0; j < visible.length; j++) {
    var item = visible[j];
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;border:2px solid ' + MARKED + ';background:rgba(245,158,11,0.10);opacity:' + item.o + ';left:' + item.r.x + 'px;top:' + item.r.y + 'px;width:' + item.r.width + 'px;height:' + item.r.height + 'px;';
    var dot = document.createElement('div');
    dot.textContent = String(item.b.n);
    dot.style.cssText = 'position:absolute;left:-10px;top:-10px;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:' + MARKED + ';color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);';
    box.appendChild(dot);
    badgeLayer.appendChild(box);
  }
}
function scheduleLayout() {
  if (!isTop || frame) return;
  frame = requestAnimationFrame(layoutBadges);
}
function applyMode() {
  if (mode) {
    ensureHost();
    if (!cursorStyle) {
      cursorStyle = document.createElement('style');
      cursorStyle.textContent = '*{cursor:crosshair !important}';
      (document.head || document.documentElement).appendChild(cursorStyle);
    }
  } else {
    hideHover();
    if (cursorStyle) { cursorStyle.remove(); cursorStyle = null; }
  }
}
function applyBadges() {
  if (!isTop) return;
  if (badges.length > 0) {
    ensureHost();
    if (!timer) timer = setInterval(scheduleLayout, 400);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
  cache = {};
  if (host) layoutBadges();
}

BLOCKED.forEach(function (type) { window.addEventListener(type, onBlocked, true); });
window.addEventListener('mousemove', onMove, true);
window.addEventListener('keydown', onKey, true);
window.addEventListener('scroll', scheduleLayout, true);
window.addEventListener('resize', scheduleLayout, true);
document.addEventListener('mouseleave', hideHover, true);

window.__piMarksApi = {
  setState: function (state) {
    mode = !!state.mode;
    badges = state.badges || [];
    applyMode();
    applyBadges();
  },
  setHidden: function (value) {
    hidden = !!value;
    if (host) host.style.display = hidden ? 'none' : '';
  },
  measure: function (request) {
    var ids = request.ids || [];
    var vv = window.visualViewport;
    var viewWidth = vv ? vv.width : window.innerWidth;
    var viewHeight = vv ? vv.height : window.innerHeight;
    var de = document.documentElement;
    var offX = request.fullPage ? window.scrollX : 0;
    var offY = request.fullPage ? window.scrollY : 0;
    var rects = [];
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      if (ids.indexOf(b.id) === -1) continue;
      var found = resolve(b.selector);
      if (!found) continue;
      rects.push({ id: b.id, x: found.rect.x + offX, y: found.rect.y + offY, width: found.rect.width, height: found.rect.height });
    }
    return {
      cssWidth: request.fullPage ? Math.max(viewWidth, de.scrollWidth) : viewWidth,
      cssHeight: request.fullPage ? Math.max(viewHeight, de.scrollHeight) : viewHeight,
      rects: rects
    };
  }
};
send({ t: 'ready', top: isTop });
})();`
