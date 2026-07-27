(function () {
  'use strict';

  const BB = (window.BB = window.BB || {});

  function text(value) {
    return String(value == null ? '' : value);
  }

  function formatBytes(value) {
    const size = Number(value || 0);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size.toLocaleString()} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let amount = size;
    let unit = 'B';
    for (const candidate of units) {
      amount /= 1024;
      unit = candidate;
      if (amount < 1024) break;
    }
    return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
  }

  function createTabs(definitions) {
    const wrapper = document.createElement('section');
    wrapper.className = 'structured-preview';
    const tabs = document.createElement('div');
    tabs.className = 'spreadsheet-tabs structured-preview-tabs';
    tabs.setAttribute('role', 'tablist');
    const host = document.createElement('div');
    host.className = 'structured-preview-host';
    const buttons = [];
    const panels = [];

    const activate = index => {
      buttons.forEach((button, buttonIndex) => {
        const active = buttonIndex === index;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index; });
    };

    definitions.forEach((definition, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `spreadsheet-tab${index === 0 ? ' is-active' : ''}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(index === 0));
      button.tabIndex = index === 0 ? 0 : -1;
      if (definition.icon) {
        const icon = document.createElement('i');
        icon.className = `mdi mdi-${definition.icon}`;
        button.appendChild(icon);
      }
      const label = document.createElement('span');
      label.textContent = definition.label;
      button.appendChild(label);
      const panel = document.createElement('div');
      panel.className = `structured-preview-panel ${definition.className || ''}`.trim();
      panel.setAttribute('role', 'tabpanel');
      panel.hidden = index !== 0;
      const content = typeof definition.render === 'function' ? definition.render() : definition.node;
      if (content) panel.appendChild(content);
      button.addEventListener('click', () => activate(index));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        activate(next);
        buttons[next]?.focus();
      });
      buttons.push(button);
      panels.push(panel);
      tabs.appendChild(button);
      host.appendChild(panel);
    });

    wrapper.append(tabs, host);
    return wrapper;
  }

  function propertyGrid(properties, emptyMessage = '') {
    const entries = Object.entries(properties || {}).filter(([, value]) => text(value).trim());
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'structured-empty';
      empty.textContent = emptyMessage;
      return empty;
    }
    const grid = document.createElement('dl');
    grid.className = 'structured-property-grid';
    entries.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'structured-property-row';
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = text(value);
      row.append(term, description);
      grid.appendChild(row);
    });
    return grid;
  }

  function chips(values, className = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `structured-chips ${className}`.trim();
    (values || []).filter(Boolean).forEach(value => {
      const chip = document.createElement('span');
      chip.className = 'structured-chip';
      chip.textContent = text(value);
      wrapper.appendChild(chip);
    });
    return wrapper;
  }

  function labeledList(label, values, icon = '') {
    const list = (values || []).filter(Boolean);
    if (!list.length) return null;
    const row = document.createElement('div');
    row.className = 'structured-card-field';
    const heading = document.createElement('strong');
    if (icon) {
      const iconElement = document.createElement('i');
      iconElement.className = `mdi mdi-${icon}`;
      heading.appendChild(iconElement);
    }
    const caption = document.createElement('span');
    caption.textContent = label;
    heading.appendChild(caption);
    row.append(heading, chips(list));
    return row;
  }

  function contactPreview(payload) {
    const section = document.createElement('div');
    section.className = 'contact-preview-grid';
    const contacts = Array.from(payload.contacts || []);
    if (!contacts.length) return propertyGrid(payload.properties, 'No contact record was found.');
    contacts.forEach((contact, index) => {
      const card = document.createElement('article');
      card.className = 'contact-preview-card';
      const avatar = document.createElement('div');
      avatar.className = 'contact-preview-avatar';
      const nameValue = text(contact.name || contact.structuredName || `Contact ${index + 1}`);
      avatar.textContent = nameValue.trim().slice(0, 2).toUpperCase() || 'VC';
      const body = document.createElement('div');
      body.className = 'contact-preview-body';
      const title = document.createElement('h2');
      title.textContent = nameValue;
      body.appendChild(title);
      if (contact.title || contact.organization) {
        const subtitle = document.createElement('p');
        subtitle.className = 'contact-preview-subtitle';
        subtitle.textContent = [contact.title, contact.organization].filter(Boolean).join(' · ');
        body.appendChild(subtitle);
      }
      [
        labeledList('Email', contact.emails, 'information-outline'),
        labeledList('Phone', contact.phones, 'information-outline'),
        labeledList('Address', contact.addresses, 'information-outline'),
        labeledList('Website', contact.urls, 'information-outline'),
        labeledList('Notes', contact.notes, 'information-outline')
      ].filter(Boolean).forEach(node => body.appendChild(node));
      card.append(avatar, body);
      section.appendChild(card);
    });
    return section;
  }

  function calendarRecords(calendar) {
    return [
      ...(calendar?.events || []),
      ...(calendar?.todos || []),
      ...(calendar?.freeBusy || []),
      ...(calendar?.journals || [])
    ];
  }

  function calendarPreview(payload) {
    const root = document.createElement('div');
    root.className = 'calendar-preview';
    const calendar = payload.calendar || {};
    if (calendar.name || calendar.timezone || calendar.method) {
      const header = document.createElement('div');
      header.className = 'calendar-preview-header';
      const title = document.createElement('h2');
      title.textContent = calendar.name || 'Calendar';
      const meta = document.createElement('p');
      meta.textContent = [calendar.timezone, calendar.method].filter(Boolean).join(' · ');
      header.append(title, meta);
      root.appendChild(header);
    }
    const records = calendarRecords(calendar);
    if (!records.length) {
      root.appendChild(propertyGrid(payload.properties, 'No calendar item was found.'));
      return root;
    }
    const list = document.createElement('div');
    list.className = 'calendar-preview-list';
    records.forEach((record, index) => {
      const card = document.createElement('article');
      card.className = 'calendar-preview-card';
      const date = document.createElement('div');
      date.className = 'calendar-preview-date';
      date.textContent = text(record.start || record.due || record.type || index + 1);
      const body = document.createElement('div');
      body.className = 'calendar-preview-body';
      const title = document.createElement('h3');
      title.textContent = text(record.summary || record.type || `Item ${index + 1}`);
      const meta = document.createElement('p');
      meta.className = 'calendar-preview-meta';
      meta.textContent = [record.type, record.end ? `Ends ${record.end}` : '', record.location, record.status].filter(Boolean).join(' · ');
      body.append(title, meta);
      if (record.description) {
        const description = document.createElement('p');
        description.className = 'calendar-preview-description';
        description.textContent = record.description;
        body.appendChild(description);
      }
      if (record.organizer || record.recurrence) {
        body.appendChild(chips([record.organizer, record.recurrence]));
      }
      card.append(date, body);
      list.appendChild(card);
    });
    root.appendChild(list);
    return root;
  }

  function emailPreview(payload) {
    const email = payload.email || {};
    const root = document.createElement('article');
    root.className = 'email-preview';
    root.appendChild(propertyGrid(email.headers || payload.properties, 'No readable email headers were found.'));
    if (email.bodyText) {
      const bodyHeading = document.createElement('h2');
      bodyHeading.textContent = 'Message';
      const body = document.createElement('pre');
      body.className = 'email-preview-body';
      body.textContent = email.bodyText;
      root.append(bodyHeading, body);
    }
    if (Array.isArray(email.attachments) && email.attachments.length) {
      const heading = document.createElement('h2');
      heading.textContent = 'Attachments';
      const list = document.createElement('div');
      list.className = 'email-attachment-list';
      email.attachments.forEach(attachment => {
        const item = document.createElement('div');
        item.className = 'email-attachment';
        const icon = document.createElement('i');
        icon.className = 'mdi mdi-file-outline';
        const body = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = attachment.name || attachment.contentId || 'Attachment';
        const meta = document.createElement('span');
        meta.textContent = [attachment.contentType, formatBytes(attachment.size), attachment.inline ? 'Inline' : ''].filter(Boolean).join(' · ');
        body.append(name, meta);
        item.append(icon, body);
        list.appendChild(item);
      });
      root.append(heading, list);
    }
    return root;
  }

  function certificatePreview(payload) {
    const root = document.createElement('div');
    root.className = 'certificate-preview';
    const certificates = Array.from(payload.certificates || []);
    if (!certificates.length) {
      root.appendChild(propertyGrid(payload.properties, 'No decoded certificate information was found.'));
      return root;
    }
    certificates.forEach((properties, index) => {
      const card = document.createElement('section');
      card.className = 'certificate-preview-card';
      const heading = document.createElement('h2');
      heading.innerHTML = '<i class="mdi mdi-shield-key-outline"></i>';
      const label = document.createElement('span');
      label.textContent = certificates.length > 1 ? `Block ${index + 1}` : payload.container || 'Certificate';
      heading.appendChild(label);
      card.append(heading, propertyGrid(properties));
      root.appendChild(card);
    });
    return root;
  }

  function rawPreview(payload) {
    const root = document.createElement('div');
    root.className = 'structured-raw-preview';
    if (payload.rawEncoding && payload.rawEncoding !== 'text') {
      const note = document.createElement('div');
      note.className = 'preview-notice structured-raw-note';
      note.textContent = `Binary object shown as ${payload.rawEncoding}.`;
      root.appendChild(note);
    }
    const code = BB.render?.renderCode
      ? BB.render.renderCode(text(payload.raw), 'plaintext')
      : (() => { const pre = document.createElement('pre'); pre.textContent = text(payload.raw); return pre; })();
    root.appendChild(code);
    return root;
  }

  function renderStructured(payload) {
    let renderPreview = () => propertyGrid(payload.properties);
    let previewIcon = 'file-document-outline';
    if (payload.kind === 'contact') {
      renderPreview = () => contactPreview(payload);
      previewIcon = 'file-document-outline';
    } else if (payload.kind === 'calendar') {
      renderPreview = () => calendarPreview(payload);
      previewIcon = 'clock-outline';
    } else if (payload.kind === 'email') {
      renderPreview = () => emailPreview(payload);
      previewIcon = 'file-document-outline';
    } else if (payload.kind === 'certificate') {
      renderPreview = () => certificatePreview(payload);
      previewIcon = 'shield-key-outline';
    }
    return createTabs([
      { label: 'Preview', icon: previewIcon, render: renderPreview },
      { label: 'Raw', icon: 'file-code-outline', render: () => rawPreview(payload), className: 'structured-raw-panel' }
    ]);
  }


  function archiveEntries(payload) {
    const root = document.createElement('div');
    root.className = 'archive-entries-preview';
    const toolbar = document.createElement('div');
    toolbar.className = 'data-preview-toolbar archive-preview-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'archive-entry-search';
    search.placeholder = 'Filter entries';
    search.setAttribute('aria-label', 'Filter archive entries');
    const summary = document.createElement('span');
    summary.className = 'data-preview-summary';
    const selectionSummary = document.createElement('span');
    selectionSummary.className = 'archive-selection-summary';
    const extractButton = document.createElement('button');
    extractButton.type = 'button';
    extractButton.className = 'bb-btn archive-extract-selected';
    extractButton.textContent = 'Extract selected';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'bb-btn archive-clear-selection';
    clearButton.textContent = 'Clear';
    const pageSizeLabel = document.createElement('label');
    pageSizeLabel.className = 'data-page-size archive-page-size';
    const pageSizeCaption = document.createElement('span');
    pageSizeCaption.textContent = 'Items';
    const pageSizeSelect = document.createElement('select');
    pageSizeSelect.setAttribute('aria-label', 'Archive entries per page');
    [100, 250, 500, 1000].forEach(value => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      if (value === 100) option.selected = true;
      pageSizeSelect.appendChild(option);
    });
    pageSizeLabel.append(pageSizeCaption, pageSizeSelect);
    const canWrite = !BB.capabilities || BB.capabilities.actionable(BB.cfg || {}, 'write');
    const selectionActions = document.createElement('div');
    selectionActions.className = 'archive-selection-actions';
    if (canWrite) selectionActions.append(selectionSummary, extractButton, clearButton);
    toolbar.append(search, summary, selectionActions, pageSizeLabel);

    const scroller = document.createElement('div');
    scroller.className = 'data-table-scroll archive-entry-scroll';
    const table = document.createElement('table');
    table.className = 'data-table archive-entry-table';
    const colgroup = document.createElement('colgroup');
    [
      ['archive-col-select', '4%'],
      ['archive-col-name', '34%'],
      ['archive-col-compressed', '12%'],
      ['archive-col-size', '12%'],
      ['archive-col-method', '10%'],
      ['archive-col-modified', '20%'],
      ['archive-col-actions', '8%']
    ].forEach(([className, width]) => {
      const column = document.createElement('col');
      column.className = className;
      column.style.width = width;
      colgroup.appendChild(column);
    });
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const selectHead = document.createElement('th');
    selectHead.className = 'archive-cell-select';
    const selectVisible = document.createElement('input');
    selectVisible.type = 'checkbox';
    selectVisible.setAttribute('aria-label', 'Select visible archive entries');
    selectHead.appendChild(selectVisible);
    [
      ['archive-cell-name', 'Name'],
      ['archive-cell-compressed is-numeric', 'Compressed'], ['archive-cell-size is-numeric', 'Size'],
      ['archive-cell-method', 'Method'], ['archive-cell-modified', 'Modified'],
      ['archive-cell-actions', '']
    ].forEach(([className, label]) => {
      const cell = document.createElement('th');
      cell.className = className;
      cell.textContent = label;
      if (className === 'archive-cell-actions') cell.setAttribute('aria-label', 'Actions');
      headRow.appendChild(cell);
    });
    headRow.prepend(selectHead);
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    table.append(colgroup, head, body);
    scroller.appendChild(table);

    const pagination = document.createElement('div');
    pagination.className = 'data-preview-pagination archive-pagination';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'icon-btn';
    previous.innerHTML = '<i class="mdi mdi-chevron-left"></i>';
    previous.setAttribute('aria-label', 'Previous page');
    const pageLabel = document.createElement('span');
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'icon-btn';
    next.innerHTML = '<i class="mdi mdi-chevron-right"></i>';
    next.setAttribute('aria-label', 'Next page');
    pagination.append(previous, pageLabel, next);

    let page = 0;
    let pageSize = 100;
    let currentVisible = [];
    const selected = new Set();
    const allEntries = Array.from(payload.entries || []).filter(entry => entry && entry.name);
    const selectable = entry => !entry.encrypted;

    const defaultTarget = () => {
      const filename = text(payload.key).split('/').pop() || 'archive';
      const base = filename.replace(/\.[^.]+$/, '') || 'archive';
      return `${base}/`;
    };

    const updateSelection = () => {
      const count = selected.size;
      selectionSummary.textContent = count ? `${count.toLocaleString()} selected` : '';
      extractButton.disabled = count === 0;
      clearButton.disabled = count === 0;
      const visibleFiles = currentVisible.filter(selectable);
      const selectedVisible = visibleFiles.filter(entry => selected.has(entry.name)).length;
      selectVisible.checked = visibleFiles.length > 0 && selectedVisible === visibleFiles.length;
      selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleFiles.length;
      selectVisible.disabled = !canWrite || visibleFiles.length === 0;
    };

    const resolveJob = async (created, label) => {
      if (created?.status === 'completed') return created;
      if (!BB.actions?.waitForJob) throw new Error('Background job controls are unavailable.');
      return BB.actions.waitForJob(created, label);
    };

    const extractEntries = async entries => {
      if (!entries.length) return;
      const target = await BB.ui.prompt({
        title: 'Extract archive entries',
        message: 'Destination prefix in the current bucket:',
        defaultValue: defaultTarget()
      });
      if (target === null) return;
      try {
        const created = await BB.api.extractArchive(payload.key, entries, {
          instance: payload.instance,
          version: payload.version || '',
          target: String(target || '').replace(/^\/+/, '')
        });
        const completed = await resolveJob(created, 'Extracting archive entries');
        if (completed.status === 'completed') {
          const result = completed.archiveExtract || {};
          BB.ui.toast(`${Number(result.extracted || entries.length).toLocaleString()} archive entr${entries.length === 1 ? 'y' : 'ies'} extracted.`, { status: 'success', duration: 5000 });
          entries.forEach(name => selected.delete(name));
          updateSelection();
        }
      } catch (error) {
        BB.ui.alert({ title: 'Archive extraction failed', message: String(error?.message || error) });
      }
    };

    const render = () => {
      const query = search.value.trim().toLowerCase();
      const filtered = query
        ? allEntries.filter(entry => text(entry.name).toLowerCase().includes(query))
        : allEntries;
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.max(0, Math.min(page, pages - 1));
      const start = page * pageSize;
      currentVisible = filtered.slice(start, start + pageSize);
      body.replaceChildren();
      currentVisible.forEach(entry => {
        const row = document.createElement('tr');
        const select = document.createElement('td');
        select.className = 'archive-cell-select';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(entry.name);
        checkbox.disabled = !canWrite || !selectable(entry);
        checkbox.setAttribute('aria-label', `Select ${entry.name}`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(entry.name);
          else selected.delete(entry.name);
          updateSelection();
        });
        select.appendChild(checkbox);
        const name = document.createElement('td');
        name.className = 'archive-cell-name';
        const nameContent = document.createElement('div');
        nameContent.className = 'archive-entry-name';
        const icon = document.createElement('i');
        icon.className = 'mdi mdi-file-outline';
        const value = document.createElement('span');
        value.textContent = entry.name;
        nameContent.append(icon, value);
        name.appendChild(nameContent);
        const compressed = document.createElement('td');
        compressed.className = 'archive-cell-compressed is-numeric';
        compressed.textContent = formatBytes(entry.compressedSize);
        const size = document.createElement('td');
        size.className = 'archive-cell-size is-numeric';
        size.textContent = formatBytes(entry.uncompressedSize);
        const method = document.createElement('td');
        method.className = 'archive-cell-method';
        method.textContent = entry.method || '';
        const modified = document.createElement('td');
        modified.className = 'archive-cell-modified';
        modified.textContent = entry.modified || '';
        const actions = document.createElement('td');
        actions.className = 'archive-cell-actions';
        if (selectable(entry)) {
          const menu = document.createElement('div');
          menu.className = 'bb-menu archive-entry-menu';
          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'bb-kebab';
          trigger.title = 'Options';
          trigger.setAttribute('aria-label', `Options for ${entry.name}`);
          trigger.setAttribute('aria-haspopup', 'menu');
          trigger.setAttribute('aria-expanded', 'false');
          trigger.innerHTML = '<i class="mdi mdi-dots-vertical" aria-hidden="true"></i>';

          const popover = document.createElement('div');
          popover.className = 'bb-menu-popover';
          const list = document.createElement('div');
          list.className = 'bb-menu-list';

          const preview = document.createElement('a');
          preview.className = 'bb-menu-item';
          preview.innerHTML = '<i class="mdi mdi-eye-outline" aria-hidden="true"></i><span>Open</span>';
          preview.href = BB.api.previewPageURL(payload.key, {
            instance: payload.instance,
            version: payload.version || '',
            entry: entry.name
          });

          const download = document.createElement('a');
          download.className = 'bb-menu-item';
          download.innerHTML = '<i class="mdi mdi-download" aria-hidden="true"></i><span>Download</span>';
          download.href = BB.api.archiveEntryURL(payload.key, entry.name, { inline: false, instance: payload.instance, version: payload.version || '' });
          download.download = entry.name.split('/').pop() || 'archive-entry';
          list.append(preview, download);

          if (canWrite) {
            const extract = document.createElement('button');
            extract.type = 'button';
            extract.className = 'bb-menu-item';
            extract.innerHTML = '<i class="mdi mdi-archive-arrow-down-outline" aria-hidden="true"></i><span>Extract</span>';
            extract.addEventListener('click', () => extractEntries([entry.name]));
            list.appendChild(extract);
          }
          popover.appendChild(list);
          menu.append(trigger, popover);
          actions.appendChild(menu);
        }
        row.append(select, name, compressed, size, method, modified, actions);
        body.appendChild(row);
      });
      const end = Math.min(filtered.length, start + currentVisible.length);
      summary.textContent = filtered.length ? `${(start + 1).toLocaleString()}-${end.toLocaleString()} of ${filtered.length.toLocaleString()}` : '0 entries';
      pageLabel.textContent = `${page + 1} / ${pages}`;
      previous.disabled = page <= 0;
      next.disabled = page >= pages - 1;
      const multiple = filtered.length > pageSize;
      previous.classList.toggle('is-pagination-placeholder', !multiple);
      next.classList.toggle('is-pagination-placeholder', !multiple);
      pageLabel.style.visibility = multiple ? '' : 'hidden';
      updateSelection();
    };
    search.addEventListener('input', () => { page = 0; render(); });
    pageSizeSelect.addEventListener('change', () => { pageSize = Number(pageSizeSelect.value) || 100; page = 0; render(); });
    previous.addEventListener('click', () => { page--; render(); });
    next.addEventListener('click', () => { page++; render(); });
    selectVisible.addEventListener('change', () => {
      currentVisible.filter(selectable).forEach(entry => {
        if (selectVisible.checked) selected.add(entry.name);
        else selected.delete(entry.name);
      });
      render();
    });
    extractButton.addEventListener('click', () => extractEntries(Array.from(selected).sort()));
    clearButton.addEventListener('click', () => { selected.clear(); render(); });
    render();
    root.append(toolbar, scroller, pagination);
    return root;
  }

  function epubPreview(payload) {
    const epub = payload.epub || {};
    const root = document.createElement('div');
    root.className = 'epub-preview';
    const title = document.createElement('h1');
    title.textContent = epub.title || 'EPUB publication';
    root.appendChild(title);
    const properties = {
      Authors: (epub.creators || []).join(', '),
      Language: epub.language,
      Identifier: epub.identifier,
      Publisher: epub.publisher,
      Date: epub.date,
      Rights: epub.rights,
      Subjects: (epub.subjects || []).join(', '),
      Cover: epub.cover
    };
    root.appendChild(propertyGrid(properties));
    if (epub.description) {
      const description = document.createElement('p');
      description.className = 'epub-description';
      description.textContent = epub.description;
      root.appendChild(description);
    }
    if (Array.isArray(epub.toc) && epub.toc.length) {
      const heading = document.createElement('h2');
      heading.textContent = 'Table of contents';
      const list = document.createElement('ol');
      list.className = 'epub-toc';
      epub.toc.forEach(item => {
        const row = document.createElement('li');
        row.style.setProperty('--epub-depth', String(Number(item.depth || 0)));
        const label = document.createElement('strong');
        label.textContent = item.label;
        row.appendChild(label);
        if (item.href) {
          const href = document.createElement('span');
          href.textContent = item.href;
          row.appendChild(href);
        }
        list.appendChild(row);
      });
      root.append(heading, list);
    }
    return root;
  }

  function renderArchive(payload) {
    const root = document.createElement('section');
    root.className = 'archive-preview-layout';

    if (payload.epub) {
      const publication = document.createElement('section');
      publication.className = 'archive-preview-section archive-publication-section';
      publication.appendChild(epubPreview(payload));
      root.appendChild(publication);
    }

    const contents = document.createElement('section');
    contents.className = 'archive-preview-section archive-contents-section';
    const contentsHeading = document.createElement('h2');
    contentsHeading.textContent = 'Contents';
    contents.append(contentsHeading, archiveEntries(payload));
    root.appendChild(contents);
    return root;
  }

  function renderVideo(url, key) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-video-stage media-preview';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    const status = document.createElement('div');
    status.className = 'media-preview-status';
    status.hidden = true;
    wrapper.append(video, status);
    video.addEventListener('error', () => {
      const name = text(key).split('/').pop() || 'this video';
      status.textContent = `Native video playback is unavailable for ${name}.`;
      status.hidden = false;
    });
    video.addEventListener('loadedmetadata', () => { status.hidden = true; });
    wrapper.cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    return wrapper;
  }

  BB.structuredViewers = { renderStructured, renderArchive, renderVideo };
})();
