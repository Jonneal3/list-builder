function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function clickByText(page, rootHandle, texts) {
  const candidates = Array.isArray(texts) ? texts : [texts];
  for (const t of candidates) {
    try {
      const [el] = await page.$x(`.//*[self::button or self::a or self::div or self::span][contains(normalize-space(.), ${JSON.stringify(t)})]`, rootHandle || undefined);
      if (el) { await el.click().catch(() => {}); return true; }
    } catch {}
  }
  return false;
}

async function ensureCompanyTableFields(page, opts = {}) {
  const navTimeout = Math.max(8000, Math.min(60000, Number(opts.navTimeout || 20000)));
  const emit = (e) => { try { if (typeof opts.onDebug === 'function') opts.onDebug(e); } catch {} };

  try {
    emit({ info: 'fields_setup_start' });

    // 1) Open Search settings (cog)
    let opened = false;
    try {
      // Try direct text match
      opened = await clickByText(page, null, ['Search settings']);
      if (!opened) {
        // Try aria-label variant
        const btn = await page.$('button[aria-label="View settings"], button[aria-label="Search settings"]').catch(() => null);
        if (btn) { await btn.click().catch(() => {}); opened = true; }
      }
      if (!opened) {
        // Try cog icon parent button
        const cog = await page.$('i.apollo-icon.apollo-icon-cog');
        if (cog) {
          const btn = await cog.evaluateHandle(el => el.closest('button')); 
          if (btn) { await btn.click().catch(() => {}); opened = true; }
        }
      }
    } catch {}

    // Wait for the drawer/dialog
    try { await page.waitForSelector('[role="dialog"]', { timeout: navTimeout }); } catch {}
    const dialog = await page.$('[role="dialog"]').catch(() => null);
    if (!dialog) { emit({ info: 'fields_settings_dialog_missing' }); return false; }

    // 2) Click Fields row inside the drawer
    try {
      const clickedFields = await clickByText(page, dialog, ['Fields']);
      if (!clickedFields) emit({ info: 'fields_row_not_found' });
      await delay(400);
    } catch {}

    // 3) Click "Add fields to table"
    try {
      const clickedAdd = await clickByText(page, dialog, ['Add fields to table']);
      if (!clickedAdd) emit({ info: 'add_fields_button_not_found' });
    } catch {}

    // Wait for the popover (search input visible)
    let searchInput = null;
    try { await page.waitForSelector('input[placeholder="Search"]', { timeout: navTimeout }); } catch {}
    try { searchInput = await page.$('input[placeholder="Search"]'); } catch {}

    // 4) Select all available fields in the popover (scroll through listbox)
    try {
      // Try to find a "Select all" control if present
      const selectAllClicked = await clickByText(page, null, ['Select all', 'Select All']);
      if (selectAllClicked) {
        emit({ info: 'fields_select_all_via_button' });
      } else {
        // Fallback: iteratively scroll the listbox and click options
        let clickedCount = 0;
        const listbox = await page.$('[role="listbox"]');
        if (listbox) {
          let lastClickedTotal = -1;
          for (let pass = 0; pass < 10; pass += 1) {
            const options = await page.$$('[role="listbox"] [role="option"], [role="listbox"] .zp_CL4Xr, [role="listbox"] [data-item-id]');
            for (const opt of options || []) {
              try {
                const text = await opt.evaluate(el => (el.textContent || '').trim());
                if (!text) continue;
                if (/^basic information|applied|more settings|company$/i.test(text)) continue;
                await opt.click().catch(() => {});
                clickedCount += 1;
              } catch {}
            }
            // Break if no new clicks
            if (clickedCount === lastClickedTotal) break;
            lastClickedTotal = clickedCount;
            // Scroll down to load more options
            try { await listbox.evaluate(el => el.scrollBy(0, 300)); } catch {}
            await delay(200);
          }
        }
        emit({ info: 'fields_bulk_selected', count: clickedCount });
      }
    } catch (e) {
      emit({ info: 'fields_bulk_select_error', error: String(e && (e.message || e)) });
    }

    // Close the popover (ESC)
    try { await page.keyboard.press('Escape'); } catch {}
    await delay(300);

    // 5) Verify key headers now visible in the table header
    try {
      const keys = ['Revenue', 'Location', 'Industries', 'Keywords', 'Links', 'Number of employees'];
      await page.waitForFunction((keys) => {
        const headers = Array.from(document.querySelectorAll('[role="columnheader"], th, [data-id]'));
        const headerText = headers.map(h => (h.textContent || '').trim());
        return keys.some(k => headerText.some(t => new RegExp(`\\b${k}\\b`, 'i').test(t)));
      }, { timeout: Math.max(4000, Math.min(15000, navTimeout)) }, keys);
      emit({ info: 'fields_setup_done', verifiedAnyOf: ['Revenue','Location','Industries','Keywords','Links','Number of employees'] });
      return true;
    } catch (e) {
      emit({ info: 'fields_setup_verify_failed', error: String(e && (e.message || e)) });
      return false;
    }
  } catch (error) {
    emit({ info: 'fields_setup_error', error: String(error && (error.message || error)) });
    return false;
  }
}

module.exports = { ensureCompanyTableFields };


