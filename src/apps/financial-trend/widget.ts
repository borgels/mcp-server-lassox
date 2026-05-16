export const FINANCIAL_TREND_WIDGET_HTML = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lassox Financial Trend</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #111827;
    --muted: #6b7280;
    --grid: #e5e7eb;
    --line-revenue: #2563eb;
    --line-gross: #059669;
    --line-result: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f17;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --grid: #1f2937;
    }
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { padding: 16px 20px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  .subtitle { color: var(--muted); font-size: 12px; }
  .legend { display: flex; gap: 14px; margin: 8px 0 12px; font-size: 12px; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .chart { width: 100%; height: 280px; }
  .axis text { fill: var(--muted); font-size: 11px; }
  .axis line, .axis path { stroke: var(--grid); }
  .gridline { stroke: var(--grid); stroke-dasharray: 2 3; }
  .series { fill: none; stroke-width: 2; }
  .point { stroke: var(--bg); stroke-width: 1.5; }
  .empty { color: var(--muted); font-size: 13px; padding: 24px 0; }
  table.fallback { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
  table.fallback th, table.fallback td { padding: 6px 8px; text-align: right; border-bottom: 1px solid var(--grid); }
  table.fallback th:first-child, table.fallback td:first-child { text-align: left; }
  table.fallback th { color: var(--muted); font-weight: 500; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1 id="title">Lassox financial trend</h1>
      <div class="subtitle" id="subtitle">Venter på data…</div>
    </div>
  </header>
  <div class="legend">
    <span><i class="swatch" style="background:var(--line-revenue)"></i>Omsætning</span>
    <span><i class="swatch" style="background:var(--line-gross)"></i>Bruttofortjeneste</span>
    <span><i class="swatch" style="background:var(--line-result)"></i>Årets resultat</span>
  </div>
  <svg id="chart" class="chart" viewBox="0 0 640 280" preserveAspectRatio="none" role="img" aria-label="Financial trend chart"></svg>
  <div id="empty" class="empty" hidden>Ingen rapporter at vise.</div>
  <table id="fallback" class="fallback" hidden>
    <thead><tr><th>År</th><th>Omsætning</th><th>Bruttofortjeneste</th><th>Årets resultat</th></tr></thead>
    <tbody></tbody>
  </table>
</div>
<script>
(function () {
  'use strict';

  var SERIES = [
    { key: 'revenue', label: 'Omsætning', color: 'var(--line-revenue)' },
    { key: 'grossProfit', label: 'Bruttofortjeneste', color: 'var(--line-gross)' },
    { key: 'profitLossForPeriod', label: 'Årets resultat', color: 'var(--line-result)' }
  ];
  var W = 640, H = 280;
  var PAD = { top: 14, right: 18, bottom: 28, left: 56 };
  var nextId = 1;

  function postToHost(method, params) {
    try {
      window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
    } catch (_) { /* host may not be present */ }
  }

  function requestSize() {
    var height = document.documentElement.scrollHeight || 360;
    postToHost('ui/request-size-change', { height: height, width: null });
  }

  function rpcRequest(method, params) {
    var id = nextId++;
    try {
      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    } catch (_) {}
    return id;
  }

  function format(value, currency) {
    if (value === null || value === undefined) return '—';
    var abs = Math.abs(value);
    var suffix = '';
    var n = value;
    if (abs >= 1e9) { n = value / 1e9; suffix = ' mia.'; }
    else if (abs >= 1e6) { n = value / 1e6; suffix = ' mio.'; }
    else if (abs >= 1e3) { n = value / 1e3; suffix = ' tus.'; }
    var rounded = Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1);
    return rounded.replace('.', ',') + suffix + (currency ? ' ' + currency : '');
  }

  function el(name, attrs, children) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    if (children) for (var i = 0; i < children.length; i++) node.appendChild(children[i]);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function render(data) {
    var titleEl = document.getElementById('title');
    var subtitleEl = document.getElementById('subtitle');
    var chart = document.getElementById('chart');
    var empty = document.getElementById('empty');
    var fallback = document.getElementById('fallback');

    var company = data && data.company || {};
    titleEl.textContent = company.name || 'Lassox financial trend';
    var subtitleBits = [];
    if (company.cvr) subtitleBits.push('CVR ' + company.cvr);
    if (data.currency) subtitleBits.push(data.currency);
    subtitleBits.push((data.reports || []).length + ' år');
    subtitleEl.textContent = subtitleBits.join(' · ');

    clear(chart);
    var reports = (data && data.reports) || [];
    if (reports.length === 0) {
      empty.hidden = false;
      fallback.hidden = true;
      requestSize();
      return;
    }
    empty.hidden = true;

    var xs = reports.map(function (r) { return r.year; });
    var allValues = [];
    SERIES.forEach(function (s) {
      reports.forEach(function (r) { if (typeof r[s.key] === 'number') allValues.push(r[s.key]); });
    });
    if (allValues.length === 0) {
      fallback.hidden = false;
      renderFallback(reports, data.currency);
      requestSize();
      return;
    }

    var minY = Math.min.apply(null, allValues);
    var maxY = Math.max.apply(null, allValues);
    if (minY === maxY) { minY -= 1; maxY += 1; }
    if (minY > 0) minY = 0;
    if (maxY < 0) maxY = 0;
    var rangeY = maxY - minY;
    minY -= rangeY * 0.08;
    maxY += rangeY * 0.08;

    var innerW = W - PAD.left - PAD.right;
    var innerH = H - PAD.top - PAD.bottom;
    function xScale(i) {
      if (xs.length === 1) return PAD.left + innerW / 2;
      return PAD.left + (i / (xs.length - 1)) * innerW;
    }
    function yScale(v) { return PAD.top + innerH - ((v - minY) / (maxY - minY)) * innerH; }

    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var v = minY + (t / ticks) * (maxY - minY);
      var y = yScale(v);
      chart.appendChild(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: 'gridline' }));
      var label = el('text', { x: PAD.left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis' });
      label.appendChild(document.createTextNode(format(v, data.currency)));
      chart.appendChild(label);
    }

    xs.forEach(function (year, i) {
      var x = xScale(i);
      var label = el('text', { x: x, y: H - PAD.bottom + 16, 'text-anchor': 'middle', class: 'axis' });
      label.appendChild(document.createTextNode(String(year)));
      chart.appendChild(label);
    });

    SERIES.forEach(function (s) {
      var points = [];
      reports.forEach(function (r, i) {
        var v = r[s.key];
        if (typeof v !== 'number') return;
        points.push([xScale(i), yScale(v)]);
      });
      if (points.length === 0) return;
      var d = points.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      chart.appendChild(el('path', { d: d, class: 'series', stroke: s.color }));
      points.forEach(function (p) {
        chart.appendChild(el('circle', { cx: p[0], cy: p[1], r: 3.5, fill: s.color, class: 'point' }));
      });
    });

    fallback.hidden = true;
    requestSize();
  }

  function renderFallback(reports, currency) {
    var tbody = document.querySelector('#fallback tbody');
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    reports.forEach(function (r) {
      var tr = document.createElement('tr');
      [r.year, r.revenue, r.grossProfit, r.profitLossForPeriod].forEach(function (cell, i) {
        var td = document.createElement('td');
        td.textContent = i === 0 ? String(cell) : format(cell, currency);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function extractStructured(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.method === 'ui/notifications/tool-result' && message.params) {
      var result = message.params.result || message.params.toolResult || message.params;
      if (result && result.structuredContent) return result.structuredContent;
    }
    if (message.method === 'ui/notifications/tool-input' && message.params) {
      return null;
    }
    if (message.result && message.result.structuredContent) {
      return message.result.structuredContent;
    }
    return null;
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    var structured = extractStructured(data);
    if (structured) render(structured);
  });

  postToHost('ui/notifications/initialized', { protocolVersion: '2026-01-26' });
  requestSize();
})();
</script>
</body>
</html>
`;
