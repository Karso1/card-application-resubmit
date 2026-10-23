(() => {
  'use strict';
  if (document.getElementById('card-address-helper')) return;
  const LIST = '#/cardManage/cardApply';
  const FORM = '#/cardManage/card-suaudit/';
  const seen = new Set();
  const deferred = new Map();
  const rejectedAddresses = new Map();
  const lastAddress = new Map();
  const addressCursor = new Map();
  const submittedAddresses = new Map();
  const limitAddressIds = new Set();
  const finalAddressRetry = new Set();
  const nameRepairs = new Set();
  let retryAfter = 0, directRetry = null;
  const frequencyRetries = new Map();
  const attemptedOrders = new Set(), successfulOrders = new Set();
  const skipReasons = new Map();
  const noticeStates = new WeakMap();
  let pendingSubmit = null, noticeRoute = location.hash;
  let enabled = false, busy = false, epoch = 0, openingAt = 0;
  let lastRoute = location.hash, routeSince = Date.now();
  let pageSignature = '', pageStableSince = Date.now();
  let scanStarted = false, pass = 1, pageMove = null, startPage = null;
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const selectedValue = select => {
    const item = select?.querySelector('.ant-select-selection-item');
    return (item?.getAttribute('title') || text(item)).trim();
  };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  const host = document.createElement('aside');
  host.id = 'card-address-helper';
  host.style.cssText = 'position:fixed;right:16px;top:100px;z-index:2147483647;width:285px';
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `<style>
    :host{font:14px/1.6 system-ui,sans-serif;color:#172033}
    section{background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:15px;box-shadow:0 8px 30px #0002}
    header{display:flex;align-items:center;justify-content:space-between;cursor:move;touch-action:none;user-select:none}
    h3{font-size:16px;margin:0}p{margin:8px 0;white-space:pre-wrap}
    header button{margin:0;padding:3px 8px}section.folded #body{display:none}
    small{display:block;color:#64748b}button{border:0;border-radius:6px;padding:8px 12px;margin:8px 6px 0 0;cursor:pointer;background:#2563eb;color:#fff}
    button.secondary{background:#e2e8f0;color:#172033}#status{background:#f1f5f9;padding:9px;border-radius:6px}
  </style><section><header><h3>开卡申请管理重新提交 · v1.29</h3><button id="fold" type="button" title="收起或展开">−</button></header><div id="body">
    <small>自动选择已有地址并点击“重新提交”；地址列表加载慢时等待 5 秒。</small>
    <p id="status">已暂停。保留当前筛选条件，点击启用。</p>
    <small id="count" style="white-space:pre-wrap">本次尝试 0 次，提交成功 0 次\n跳过原因：暂无</small>
    <button id="toggle" type="button">启用自动处理</button>
    <button id="current" class="secondary" type="button">重试当前表单</button>
    <button id="retry" class="secondary" type="button">重试跳过项</button>
  </div></section>`;
  document.body.appendChild(host);
  const prefsKey = 'card-address-helper-panel-v2';
  let folded = false;
  const clamp = (n, min, max) => Math.min(Math.max(n, min), Math.max(min, max));
  function place(x, y) {
    const rect = host.getBoundingClientRect();
    host.style.right = 'auto';
    host.style.left = clamp(x, 0, innerWidth - rect.width) + 'px';
    host.style.top = clamp(y, 0, innerHeight - rect.height) + 'px';
  }
  function savePosition() {
    const rect = host.getBoundingClientRect();
    try { localStorage.setItem(prefsKey, JSON.stringify({x:rect.x,y:rect.y,folded})); } catch {}
  }
  function fold(value) {
    folded = value;
    shadow.querySelector('section').classList.toggle('folded', value);
    shadow.getElementById('fold').textContent = value ? '+' : '−';
    const rect = host.getBoundingClientRect(); place(rect.x, rect.y);
  }
  try {
    const prefs = JSON.parse(localStorage.getItem(prefsKey));
    if (prefs && Number.isFinite(prefs.x) && Number.isFinite(prefs.y)) {
      fold(!!prefs.folded); place(prefs.x, prefs.y);
    }
  } catch {}
  shadow.getElementById('fold').onclick = () => { fold(!folded); savePosition(); };
  const header = shadow.querySelector('header');
  let drag = null;
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    drag = {id:event.pointerId,dx:event.clientX-rect.x,dy:event.clientY-rect.y};
    header.setPointerCapture(event.pointerId); event.preventDefault();
  });
  header.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) place(event.clientX-drag.dx,event.clientY-drag.dy);
  });
  const endDrag = () => { if (drag) { drag = null; savePosition(); } };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  addEventListener('resize', () => {
    if (!host.hidden) { const rect = host.getBoundingClientRect(); place(rect.x,rect.y); savePosition(); }
  });
  const status = message => { shadow.getElementById('status').textContent = message; };
  const count = () => {
    const totals = new Map();
    for (const reason of skipReasons.values()) totals.set(reason, (totals.get(reason) || 0) + 1);
    shadow.getElementById('count').textContent = `本次尝试 ${attemptedOrders.size} 次，提交成功 ${successfulOrders.size} 次，已知达上限地址 ${limitAddressIds.size} 个\n跳过原因：` +
      (totals.size ? '\n' + [...totals].map(([reason, n]) => `${reason}：${n} 笔`).join('\n') : '暂无');
  };
  function stop(message) {
    enabled = false; epoch++; openingAt = 0; pageMove = null;
    shadow.getElementById('toggle').textContent = '启用自动处理';
    status(message);
  }
  shadow.getElementById('toggle').onclick = () => {
    if (enabled) return stop('已暂停。可手动操作页面。');
    enabled = true; epoch++; routeSince = Date.now();
    if (location.hash === LIST) { startPage = null; scanStarted = false; pass = 1; }
    shadow.getElementById('toggle').textContent = '暂停';
    status('已启用，正在检查当前页面……');
    readNotices(true);
  };
  shadow.getElementById('current').onclick = () => {
    if (busy) return;
    if (!location.hash.startsWith(FORM)) return status('请先打开需要重试的申请表单。');
    seen.delete(location.hash.slice(FORM.length).split('?')[0]);
    status(enabled ? '正在重新准备当前表单……' : '已允许重试，请点击启用。');
  };
  shadow.getElementById('retry').onclick = () => {
    for (const entry of deferred.values()) { entry.attempts = 0; entry.after = 0; }
    scanStarted = false; pass = 1; startPage = null;
    for (const entry of deferred.values()) entry.pass = 0;
    status('已重置跳过项。返回列表后将从当前选中的页向前重新处理。');
  };
  function check(token, route) {
    if (!enabled || token !== epoch || location.hash !== route) throw new Error('操作已暂停或页面已切换');
  }
  async function until(fn, token, route, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      check(token, route);
      const result = fn();
      if (result) return result;
      await wait(150);
    }
    throw new Error(label + '，请人工检查后重试');
  }
  function selectedAddress(input) {
    const select = input?.closest('.ant-select');
    return !!select && all('.ant-select-selection-item', select).some(el => visible(el) && text(el));
  }
  function selectedKey(input) {
    const item = input?.closest('.ant-select')?.querySelector('.ant-select-selection-item');
    return item?.getAttribute('title') || text(item);
  }
  function optionKey(option) { return option.id || option.getAttribute('title') || text(option); }
  function selectedAddressId(input) {
    const selected = selectedKey(input);
    const popup = document.getElementById(input?.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');
    const matches = popup ? all('.ant-select-item-option', popup).filter(el => el.getAttribute('title') === selected && /^\d+$/.test(el.id)) : [];
    return matches.length === 1 ? matches[0].id : null;
  }
  function isAddressLimit(message) {
    // The backend calls this field 收件地址 in its error toast, although the form uses shippingId.
    if (/(?:未|没有|不)(?:超过|超出|达到)/.test(message)) return false;
    return /(?:收件地址|账单地址|帳單地址).{0,40}(?:超过|超出|已达|达到).{0,20}(?:最大限制|限制|上限)/.test(message)
      || /(?:收件地址|账单地址|帳單地址).{0,40}(?:使用|绑定|使用次数|绑定数量).{0,8}(?:已达|达到).{0,8}上限/.test(message);
  }
  function readNotices(baseline = false) {
    const nodes = all('.ant-message-notice-content, .ant-notification-notice, .ant-form-item-explain-error, [role="alert"]').filter(visible);
    const fresh = [];
    for (const node of nodes) {
      const message = text(node), previous = noticeStates.get(node);
      if (!baseline && message && previous !== message) fresh.push(message);
      noticeStates.set(node, message);
    }
    return fresh;
  }
  function repairNameSymbols() {
    const changes = [];
    for (const label of all('label').filter(el => visible(el) && /^英文[姓名]$/.test(text(el).replace(/[＊*：:\s]/g, '')))) {
      const input = document.getElementById(label.getAttribute('for')) || label.closest('.ant-form-item')?.querySelector('input');
      if (!visible(input) || input.tagName !== 'INPUT' || input.disabled || input.readOnly) continue;
      const value = input.value.replace(/[\-\u2010-\u2015\u2212\uFF0D]/g, ' ').replace(/[\p{P}\p{S}]/gu, '');
      if (value === input.value) continue;
      if (!value.trim()) throw new Error('姓名清理符号后为空，请核对');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) continue;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      input.dispatchEvent(new FocusEvent('focusout', {bubbles:true}));
      changes.push({input, value});
    }
    return changes;
  }
  function handleNotices(route) {
    const messages = readNotices();
    if (pendingSubmit && Date.now() - pendingSubmit.at <= 15000 && messages.some(message => message.includes('补充资料提交成功'))) {
      const order = pendingSubmit.route.slice(FORM.length).split('?')[0];
      if (/^\d+$/.test(pendingSubmit.addressKey || '')) limitAddressIds.delete(pendingSubmit.addressKey);
      frequencyRetries.delete(order);
      successfulOrders.add(order); skipReasons.delete(order); deferred.delete(order);
      pendingSubmit = null; count();
      status('补充资料提交成功，继续处理下一笔……');
      if (route.startsWith(FORM)) location.hash = LIST;
      noticeRoute = location.hash;
      return;
    }
    if (route !== noticeRoute) { noticeRoute = route; }
    if (!route.startsWith(FORM)) return;
    const order = route.slice(FORM.length).split('?')[0];
    if (pendingSubmit?.route === route && messages.some(message => /请求过于频繁/.test(message))) {
      pendingSubmit = null; seen.delete(order);
      const retries = frequencyRetries.get(order) || 0;
      if (retries >= 2) {
        frequencyRetries.delete(order); retryAfter = 0; directRetry = null;
        const key = lastAddress.get(order) || selectedKey(document.getElementById('form_item_shippingId'));
        if (!key) { deferOrder(order, '频繁重试失败且无法确认当前地址'); return; }
        if (!rejectedAddresses.has(order)) rejectedAddresses.set(order, new Set());
        rejectedAddresses.get(order).add(key);
        status('当前地址等待 1 秒、2 秒重试后仍频繁，正在尝试下一个未试地址……');
        return;
      }
      const delay = retries + 1;
      frequencyRetries.set(order, delay);
      directRetry = {route, address: selectedKey(document.getElementById('form_item_shippingId'))};
      retryAfter = Date.now() + delay * 1000;
      status(`请求过于频繁，等待 ${delay} 秒后重新提交（第 ${delay} 次重试）……`);
      return;
    }
    if (pendingSubmit?.route === route && messages.some(message => message.includes('仅支持英文及空格')) && !nameRepairs.has(order)) {
      if (repairNameSymbols().length) {
        nameRepairs.add(order);
        pendingSubmit = null; seen.delete(order);
        routeSince = Date.now();
        status('已清理英文姓名符号，正在重新提交……');
        return;
      }
    }
    if (directRetry?.route === route) return;
    const limit = pendingSubmit?.route === route && messages.find(isAddressLimit);
    const countryRestricted = pendingSubmit?.route === route && messages.some(message => /国家受到限制[，,\s]*不允许进行该操作/.test(message));
    if (limit || countryRestricted) {
      const key = pendingSubmit?.addressKey;
      if (!key || !submittedAddresses.get(order)?.has(key)) { deferOrder(order, '收到地址报错，但无法关联本次实际提交地址'); return; }
      if (limit && /^\d+$/.test(key)) { limitAddressIds.add(key); count(); }
      if (finalAddressRetry.has(order)) {
        deferOrder(order, '最后一个地址再次提交后仍被拒绝');
        return;
      }
      if (!rejectedAddresses.has(order)) rejectedAddresses.set(order, new Set());
      rejectedAddresses.get(order).add(key);
      seen.delete(order); pendingSubmit = null;
      frequencyRetries.delete(order); directRetry = null; retryAfter = 0;
      status(countryRestricted ? '当前地址提交后提示国家受限，正在换下一项已有地址……' : '该地址已达到开卡限制，正在换下一项已有地址……');
      return;
    }
    if (pendingSubmit?.route === route && messages.some(message => /^(?:重新)?提交成功[！!。\s]*$/.test(message))) {
      pendingSubmit = null;
      deferred.delete(order);
      status('已检测到提交成功，返回列表处理下一笔……');
      location.hash = LIST;
    } else if (pendingSubmit?.route === route && messages.length) {
      pendingSubmit = null;
      deferOrder(order, '提交后出现提示：' + messages.join('；'), true);
    }
  }
  function deferOrder(order, reason, manualReview = false) {
    frequencyRetries.delete(order); retryAfter = 0; directRetry = null;
    skipReasons.set(order, reason); count();
    const attempts = manualReview ? 3 : (deferred.get(order)?.attempts || 0) + 1;
    deferred.set(order, {attempts, after:Date.now()+60000, pass});
    seen.delete(order); pendingSubmit = null;
    rejectedAddresses.delete(order); lastAddress.delete(order); addressCursor.delete(order); finalAddressRetry.delete(order);
    status(reason + (manualReview ? '，待人工核对，先处理其他申请。' : '，暂时跳过，先处理其他申请。'));
    location.hash = LIST;
  }
  async function findNextOption(input, selector, rejected, token, route) {
    const order = route.slice(FORM.length).split('?')[0];
    let startOffset = 0;
    const openDeadline = Date.now() + 5000;
    let optionDeadline = 0, clickTried = false;
    let knownDropdown = null, resetScroll = false;
    const scanDeadline = Date.now() + 60000;
    while (Date.now() < (optionDeadline || openDeadline)) {
      check(token, route);
      if (Date.now() > scanDeadline) throw new Error('地址列表扫描超时，尚未确认全部地址');
      const linked = document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');
      const open = all('.ant-select-dropdown').filter(visible);
      let dropdown = visible(linked) ? linked : null;
      if (!dropdown && open.length === 1) dropdown = open[0];
      if (!dropdown && open.length > 1) {
        const anchor = selector.getBoundingClientRect();
        const nearby = open.map(el => {
          const rect = el.getBoundingClientRect();
          const overlap = Math.min(anchor.right, rect.right) - Math.max(anchor.left, rect.left);
          // The address list can open above or below the input.
          const gap = Math.min(Math.abs(rect.bottom - anchor.top), Math.abs(rect.top - anchor.bottom));
          return {el, overlap, gap};
        }).filter(item => item.overlap > 0 && item.gap < 200).sort((a, b) => a.gap - b.gap);
        dropdown = nearby[0]?.el || null;
      }
      if (visible(dropdown)) {
        knownDropdown = dropdown;
        if (!optionDeadline) optionDeadline = Date.now() + 5000;
        const scroller = dropdown.querySelector('.rc-virtual-list-holder');
        if (!resetScroll && scroller) {
          resetScroll = true;
          startOffset = Math.min(addressCursor.get(order) || 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
          scroller.scrollTop = startOffset;
          scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
          await wait(150); continue;
        }
        const option = all('.ant-select-item-option', dropdown).find(el => visible(el) && !el.classList.contains('ant-select-item-option-disabled') && !limitAddressIds.has(el.id) && (!rejected.has(optionKey(el)) || !submittedAddresses.get(order)?.has(optionKey(el))));
        if (option) {
          if (scroller) addressCursor.set(order, scroller.scrollTop);
          return option;
        }
        if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
          const last = all('.ant-select-item-option', dropdown).filter(el => visible(el) && !el.classList.contains('ant-select-item-option-disabled') && !limitAddressIds.has(el.id)).at(-1);
          if (last && rejected.size && !finalAddressRetry.has(order)) return last;
          if (last) return null;
        }
        // Ant Design renders only part of long address lists. Walk the visible dropdown.
        const holder = dropdown.querySelector('.rc-virtual-list-holder');
        if (holder && holder.scrollTop + holder.clientHeight < holder.scrollHeight - 2) {
          optionDeadline = Date.now() + 5000;
          holder.scrollTop = Math.min(holder.scrollHeight, holder.scrollTop + Math.max(40, holder.clientHeight - 40));
          holder.dispatchEvent(new Event('scroll', {bubbles:true}));
        }
      } else if (!clickTried && Date.now() > openDeadline - 4000) {
        // Some Ant Design versions respond to click rather than mousedown.
        selector.click(); clickTried = true;
      }
      await wait(100);
    }
    if (!knownDropdown || !visible(knownDropdown)) throw new Error('地址下拉框等待后仍未打开');
    return null;
  }
  function retryCurrentAddress(token, route) {
    const order = route.slice(FORM.length).split('?')[0];
      const currentAddress = selectedKey(document.getElementById('form_item_shippingId'));
      if (!directRetry.address || currentAddress !== directRetry.address) {
        directRetry = null;
        deferOrder(order, '频繁请求重试前地址发生变化，已跳过');
        return;
      }
      check(token, route);
      const buttons = all('button').filter(el => visible(el) && text(el) === '重新提交' && !el.disabled && !el.closest('table tbody tr'));
      if (buttons.length !== 1) throw new Error('频繁请求重试时无法唯一识别重新提交按钮');
      directRetry = null; retryAfter = 0; seen.add(order);
      readNotices(true); pendingSubmit = {route, at:Date.now(), addressKey:lastAddress.get(order)};
      if (!submittedAddresses.has(order)) submittedAddresses.set(order, new Set());
      submittedAddresses.get(order).add(lastAddress.get(order));
      status('保留当前账单地址，正在重新提交……');
      buttons[0].click();
      return;
  }
  async function prepare(token, route) {
    const order = route.slice(FORM.length).split('?')[0];
    if (!/^\d+$/.test(order)) throw new Error('无法识别订单号');
    if (seen.has(order)) return;
    attemptedOrders.add(order); count();
    status('正在准备地址……');
    const label = await until(() => all('label').find(el => visible(el) && text(el) === '选择用户现有地址' && el.querySelector('input[type="radio"]')), token, route, '未找到现有地址选项');
    check(token, route);
    if (!label.querySelector('input').checked) label.click();
    const input = await until(() => {
      const el = document.getElementById('form_item_shippingId');
      return visible(el) && el.getAttribute('role') === 'combobox' ? el : null;
    }, token, route, '未找到账单地址下拉框');
    const rejected = rejectedAddresses.get(order) || new Set();
    if (!selectedAddress(input) || limitAddressIds.has(selectedAddressId(input)) || rejected.has(selectedKey(input)) || rejected.has(lastAddress.get(order))) {
      const selector = input.closest('.ant-select')?.querySelector('.ant-select-selector');
      if (!selector) throw new Error('地址控件结构发生变化');
      check(token, route);
      if (input.getAttribute('aria-expanded') !== 'true') {
        selector.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}));
      }
      const option = await findNextOption(input, selector, rejected, token, route);
      if (!option) { deferOrder(order, rejected.size ? `已实际提交 ${submittedAddresses.get(order)?.size || 0} 个地址，其他地址已达上限或未加载` : limitAddressIds.size ? '可见地址均已知达到开卡上限或暂未加载' : '地址暂未加载'); return; }
      const targetKey = optionKey(option);
      const targetLabel = option.getAttribute('title') || text(option);
      if (rejected.has(targetKey)) {
        finalAddressRetry.add(order);
        status('末项地址已选中，正在直接重新提交……');
      }
      let chosen = selectedAddress(input) && selectedKey(input) === targetLabel;
      for (let attempt = 0; attempt < 2 && !chosen; attempt++) {
        check(token, route);
        let currentInput = document.getElementById('form_item_shippingId');
        if (!currentInput) throw new Error('地址控件刷新后未找到');
        const currentSelector = currentInput.closest('.ant-select')?.querySelector('.ant-select-selector');
        if (!currentSelector) throw new Error('地址控件刷新后结构变化');
        if (attempt) {
          status(`正在重新选择地址（第 ${attempt + 1} 次），等待选中状态……`);
          currentSelector.scrollIntoView({block:'center'});
          if (currentInput.getAttribute('aria-expanded') !== 'true') {
            currentSelector.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
          }
        }
        // Reacquire virtualized option nodes; never click a detached stale node.
        let candidate = attempt === 0 && option.isConnected ? option : null;
        if (!candidate) {
          const lookupDeadline = Date.now() + 1200;
          while (Date.now() < lookupDeadline) {
            check(token, route);
            const open = all('.ant-select-dropdown').filter(visible);
            candidate = open.flatMap(root => all('.ant-select-item-option', root)).find(el => visible(el) && optionKey(el) === targetKey);
            if (candidate) break;
            await wait(150);
          }
        }
        if (!candidate) continue;
        const candidatePopup = candidate.closest('.ant-select-dropdown');
        const beforeKey = selectedKey(document.getElementById('form_item_shippingId'));
        candidate.scrollIntoView({block:'nearest'});

        // Scroll can recycle the virtual-list node: reacquire the intended option after rendering.
        await wait(100); check(token, route);
        candidate = all('.ant-select-item-option', candidatePopup).find(el => visible(el) && optionKey(el) === targetKey);
        if (!candidate) continue;
        candidate.click();
        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
          check(token, route);
          currentInput = document.getElementById('form_item_shippingId');
          const popup = document.getElementById(currentInput?.getAttribute('aria-controls'))?.closest('.ant-select-dropdown') || (candidatePopup?.isConnected ? candidatePopup : null);
          const selectedOption = (popup ? all('.ant-select-item-option', popup) : [])
            .find(el => optionKey(el) === targetKey && (el.classList.contains('ant-select-item-option-selected') || el.getAttribute('aria-selected') === 'true'));
          // Popup text may include all address details while the input shows only the street.
          if (selectedAddress(currentInput) && (selectedKey(currentInput) === targetLabel || (selectedOption && selectedKey(currentInput) !== beforeKey))) {
            await wait(100); check(token, route);
            const freshInput = document.getElementById('form_item_shippingId');
            if (selectedAddress(freshInput) && selectedKey(freshInput) === selectedKey(currentInput)) {
              chosen = true; break;
            }
          }
          await wait(150);
        }
      }
      if (!chosen) throw new Error('地址重选 2 次后仍未确认选中');
      lastAddress.set(order, targetKey);
      // Notices are handled on the next timer tick, including delayed server validation.
    }
    if (!lastAddress.has(order)) lastAddress.set(order, selectedAddressId(input) || selectedKey(input));
    const nameChanges = repairNameSymbols();
    if (nameChanges.length) {
      status('正在清理英文姓名符号并等待修改生效……');
      await wait(1200); check(token, route);
      if (nameChanges.some(({input, value}) => !input.isConnected || input.value !== value)) {
        throw new Error('姓名修改未保持，暂不提交');
      }
    }
    const buttons = all('button').filter(el => visible(el) && text(el) === '重新提交' && !el.disabled && !el.closest('table tbody tr'));
    if (buttons.length !== 1) throw new Error('无法唯一识别表单的“重新提交”按钮');
    check(token, route);
    const finalInput = document.getElementById('form_item_shippingId');
    if (!selectedAddress(finalInput) || !selectedKey(finalInput)) {
      throw new Error('提交前地址框仍为空，尚未提交该地址');
    }
    const finalSelector = finalInput.closest('.ant-select')?.querySelector('.ant-select-selector');
    if (finalInput.getAttribute('aria-expanded') === 'true' && finalSelector) {
      finalSelector.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
      await wait(200); check(token, route);
    }
    seen.add(order);
    readNotices(true);
    pendingSubmit = {route, at:Date.now(), addressKey:lastAddress.get(order)};
      if (!submittedAddresses.has(order)) submittedAddresses.set(order, new Set());
      submittedAddresses.get(order).add(lastAddress.get(order));
    status(`地址 ${lastAddress.get(order)} 已选中，正在提交并等待结果……`);
    buttons[0].click();
  }
  function pagination() {
    const roots = all('.ant-pagination').filter(visible);
    if (roots.length !== 1) throw new Error('无法唯一识别分页控件，已暂停');
    const root = roots[0];
    const items = all('li', root).filter(el => /^\d+$/.test(el.getAttribute('title') || ''));
    const current = Number(root.querySelector('.ant-pagination-item-active')?.getAttribute('title'));
    const last = Math.max(0, ...items.map(el => Number(el.getAttribute('title'))));
    if (!current || !last) throw new Error('无法读取当前页和最后一页，已暂停');
    return {root, items, current, last};
  }
  function movePage(paging, target, token, route) {
    if (paging.current === target) return;
    check(token, route);
    const item = paging.items.find(el => Number(el.getAttribute('title')) === target);
    const control = item || (target === paging.current - 1 ? paging.root.querySelector('li[title="上一页"]') : target === paging.current + 1 ? paging.root.querySelector('li[title="下一页"]') : null);
    if (!control || !visible(control) || control.getAttribute('aria-disabled') === 'true' || /disabled/.test(control.className)) {
      throw new Error('无法切换到第' + target + '页，已暂停');
    }
    pageMove = {target, at:Date.now(), signature:pageSignature};
    status(`正在转到第 ${target} 页（起始第 ${startPage} 页，第 ${pass} 轮）……`);
    control.click();
  }
  function nextFromList(token, route) {
    if (openingAt) {
      if (Date.now() - openingAt > 10000) stop('申请页面未能打开，已暂停，避免重复点击。');
      return;
    }
    const state = document.getElementById('form_item_state')?.closest('.ant-select');
    const type = document.getElementById('form_item_cardType')?.closest('.ant-select');
    const selectedCardType = selectedValue(type);
    if (!state || !type || !text(state).includes('渠道复审未通过') || !['虚拟卡', '实体卡'].includes(selectedCardType)) {
      stop('请先筛选：虚拟卡或实体卡 + 渠道复审未通过，再启用。'); return;
    }
    const rows = all('table tbody tr').filter(visible);
    const signature = rows.map(row => text(row.cells?.[1])).join('|');
    if (signature !== pageSignature) { pageSignature = signature; pageStableSince = Date.now(); return; }
    if (Date.now() - pageStableSince < 1000) return;
    if (all('.ant-spin-spinning').some(visible)) return;
    const paging = pagination();
    if (pageMove) {
      if (Date.now() - pageMove.at > 15000) throw new Error('翻页后列表未更新，已暂停，避免处理旧页面');
      if (paging.current !== pageMove.target || signature === pageMove.signature || Date.now() - pageMove.at < 1200) return;
      pageMove = null;
    }
    if (!scanStarted) {
      if (startPage === null) startPage = paging.current;
      const target = Math.min(startPage, paging.last);
      if (paging.current !== target) {
        // Retry rounds return only to the user-selected starting page.
        const direct = paging.items.some(el => Number(el.getAttribute('title')) === target);
        movePage(paging, direct ? target : paging.current + Math.sign(target - paging.current), token, route);
        return;
      }
      scanStarted = true;
    }
    // New records retain displayed order; deferred records run afterwards.
    const ordered = [...rows.filter(row => !deferred.has(text(row.cells?.[1]))), ...rows.filter(row => deferred.has(text(row.cells?.[1])))];
    for (const row of ordered) {
      const order = text(row.cells?.[1]);
      if (!/^\d{15,}$/.test(order) || seen.has(order)) continue;
      const retry = deferred.get(order);
      if (retry && (retry.attempts >= 3 || retry.after > Date.now() || retry.pass === pass)) continue;
      const cells = [...row.cells].map(text);
      if (!cells.includes(selectedCardType) || !cells.includes('渠道复审未通过')) continue;
      const button = all('button', row).find(el => visible(el) && text(el) === '重新提交' && !el.disabled);
      if (!button) continue;
      check(token, route);
      // The only resubmit-labelled button clicked is inside a LIST table row.
      // It opens the editing page. A button on the FORM is never clicked.
      if (location.hash !== LIST || !button.closest('table tbody tr')) return;
      status('正在打开下一笔申请……');
      openingAt = Date.now();
      button.click();
      return;
    }
    if (paging.current > 1) { movePage(paging, paging.current - 1, token, route); return; }
    const remaining = [...deferred.values()].filter(entry => entry.attempts < 3);
    if (remaining.length && pass < 3) {
      if (Date.now() < Math.max(...remaining.map(entry => entry.after))) {
        status('本轮已到第一页。等待跳过项冷却后，再从本次选定的起始页向前重试。'); return;
      }
      pass++; scanStarted = false;
      status('开始下一轮地址重试……'); return;
    }
    scanStarted = false; pass = 1;
    stop(`已从第 ${startPage} 页处理到第一页。本次尝试 ${attemptedOrders.size} 次，提交成功 ${successfulOrders.size} 次。跳过详情见下方。`);
  }
  setInterval(async () => {
    const route = location.hash;
    host.hidden = !(route === LIST || route.startsWith(FORM));
    if (route !== lastRoute) { lastRoute = route; routeSince = Date.now(); epoch++; openingAt = 0; }
    if (!enabled || busy || host.hidden || Date.now() - routeSince < 1200) return;
    handleNotices(route);
    if (!enabled || location.hash !== route || Date.now() < retryAfter) return;
    if (pendingSubmit?.route === route) {
      if (Date.now() - pendingSubmit.at > 15000) {
        deferOrder(route.slice(FORM.length).split('?')[0], '提交后 15 秒内未检测到成功提示', true);
      }
      return;
    }
    if (all('[role="dialog"]').some(visible)) return;
    const token = epoch;
    busy = true;
    try {
      if (directRetry?.route === route) retryCurrentAddress(token, route);
      else if (route.startsWith(FORM)) await prepare(token, route);
      else if (route === LIST) nextFromList(token, route);
    } catch (err) {
      if (enabled && token === epoch && location.hash === route) {
        if (route.startsWith(FORM)) deferOrder(route.slice(FORM.length).split('?')[0], err.message);
        else stop(err.message);
      }
    } finally { busy = false; }
  }, 500);
})();
