/*
 * GENERATED FILE: do not edit.
 * Compiled from src/frontend/app.template.html by tools/build-template.mjs (Vue 3.5.18 compiler).
 * Run `npm run build` in tools/ after changing the template; CI runs `npm run check`.
 */
(function () {
  'use strict';
  const BB = (window.BB = window.BB || {});
  BB.renderApp = (function () {
    const { withModifiers: _withModifiers, createElementVNode: _createElementVNode, normalizeClass: _normalizeClass, toDisplayString: _toDisplayString, withKeys: _withKeys, renderList: _renderList, Fragment: _Fragment, openBlock: _openBlock, createElementBlock: _createElementBlock, normalizeStyle: _normalizeStyle, createCommentVNode: _createCommentVNode, Teleport: _Teleport, createBlock: _createBlock, createTextVNode: _createTextVNode, vShow: _vShow, withDirectives: _withDirectives, vModelText: _vModelText, vModelSelect: _vModelSelect, createStaticVNode: _createStaticVNode } = Vue

    const _hoisted_1 = { id: "app" }
    const _hoisted_2 = { class: "top" }
    const _hoisted_3 = { class: "container" }
    const _hoisted_4 = { class: "head" }
    const _hoisted_5 = {
      ref: "breadcrumbRegion",
      class: "title breadcrumbs browser-breadcrumbs"
    }
    const _hoisted_6 = ["aria-current", "aria-disabled", "tabindex"]
    const _hoisted_7 = { class: "sr-only" }
    const _hoisted_8 = {
      ref: "breadcrumbLine",
      class: "breadcrumb-line",
      "aria-label": "Current location"
    }
    const _hoisted_9 = {
      key: 0,
      class: "breadcrumb-overflow"
    }
    const _hoisted_10 = ["title", "aria-expanded"]
    const _hoisted_11 = { class: "breadcrumb-overflow-count" }
    const _hoisted_12 = ["title", "onClick"]
    const _hoisted_13 = { class: "breadcrumb-overflow-node" }
    const _hoisted_14 = {
      key: 1,
      class: "breadcrumb-separator"
    }
    const _hoisted_15 = ["title", "onClick"]
    const _hoisted_16 = ["title"]
    const _hoisted_17 = {
      key: 2,
      class: "breadcrumb-separator"
    }
    const _hoisted_18 = { class: "header-tools" }
    const _hoisted_19 = { class: "storage-switcher-bar" }
    const _hoisted_20 = ["aria-expanded", "title"]
    const _hoisted_21 = { class: "storage-switcher-copy" }
    const _hoisted_22 = { key: 0 }
    const _hoisted_23 = ["aria-label", "title"]
    const _hoisted_24 = ["title"]
    const _hoisted_25 = ["aria-expanded", "onClick"]
    const _hoisted_26 = { class: "storage-host-copy" }
    const _hoisted_27 = ["aria-label"]
    const _hoisted_28 = ["aria-current", "onClick"]
    const _hoisted_29 = { class: "storage-option-copy" }
    const _hoisted_30 = { class: "storage-option-title-row" }
    const _hoisted_31 = ["aria-label"]
    const _hoisted_32 = ["title"]
    const _hoisted_33 = { key: 0 }
    const _hoisted_34 = { key: 1 }
    const _hoisted_35 = {
      class: "storage-option-check",
      "aria-hidden": "true"
    }
    const _hoisted_36 = {
      key: 0,
      class: "mdi mdi-check"
    }
    const _hoisted_37 = {
      key: 1,
      class: "storage-switcher is-static-switcher"
    }
    const _hoisted_38 = { class: "storage-switcher-bar" }
    const _hoisted_39 = ["title"]
    const _hoisted_40 = { class: "storage-switcher-copy" }
    const _hoisted_41 = { key: 0 }
    const _hoisted_42 = ["aria-label", "title"]
    const _hoisted_43 = ["title"]
    const _hoisted_44 = {
      key: 2,
      class: "storage-switcher is-static-switcher is-loading-switcher",
      "aria-hidden": "true"
    }
    const _hoisted_45 = {
      class: "toolbar",
      "aria-label": "Folder actions"
    }
    const _hoisted_46 = { class: "container toolbar-row" }
    const _hoisted_47 = ["disabled"]
    const _hoisted_48 = ["disabled"]
    const _hoisted_49 = { class: "toolbar-right" }
    const _hoisted_50 = ["disabled"]
    const _hoisted_51 = { class: "bb-menu toolbar-menu" }
    const _hoisted_52 = { class: "bb-menu-popover" }
    const _hoisted_53 = {
      class: "bb-menu-list",
      role: "menu"
    }
    const _hoisted_54 = ["disabled"]
    const _hoisted_55 = ["disabled"]
    const _hoisted_56 = {
      key: 0,
      class: "bb-menu toolbar-menu"
    }
    const _hoisted_57 = { class: "bb-menu-popover" }
    const _hoisted_58 = {
      class: "bb-menu-list",
      role: "menu"
    }
    const _hoisted_59 = {
      class: "upload-drop-overlay",
      role: "status",
      "aria-live": "polite"
    }
    const _hoisted_60 = { class: "upload-drop-card" }
    const _hoisted_61 = { class: "mono" }
    const _hoisted_62 = {
      id: "main-content",
      class: "container main-content",
      tabindex: "-1"
    }
    const _hoisted_63 = {
      key: 0,
      class: "empty-state card"
    }
    const _hoisted_64 = {
      key: 1,
      class: "empty-state card is-error"
    }
    const _hoisted_65 = {
      key: 2,
      class: "empty-state card is-warning"
    }
    const _hoisted_66 = {
      key: 3,
      class: "card browser-card"
    }
    const _hoisted_67 = {
      key: 0,
      class: "card-content browser-card-head"
    }
    const _hoisted_68 = { class: "page-size-control" }
    const _hoisted_69 = { class: "select select-sm" }
    const _hoisted_70 = ["disabled"]
    const _hoisted_71 = { class: "pagination-control" }
    const _hoisted_72 = ["aria-hidden", "tabindex", "disabled"]
    const _hoisted_73 = { "aria-live": "polite" }
    const _hoisted_74 = ["aria-hidden", "tabindex", "disabled"]
    const _hoisted_75 = { class: "card-content table-card-content" }
    const _hoisted_76 = ["aria-busy"]
    const _hoisted_77 = { class: "table" }
    const _hoisted_78 = { class: "sr-only" }
    const _hoisted_79 = ["aria-sort"]
    const _hoisted_80 = ["disabled", "aria-label"]
    const _hoisted_81 = ["aria-sort"]
    const _hoisted_82 = ["disabled", "aria-label"]
    const _hoisted_83 = ["aria-sort"]
    const _hoisted_84 = { class: "modified-header-controls" }
    const _hoisted_85 = ["title", "aria-label"]
    const _hoisted_86 = ["disabled", "aria-label"]
    const _hoisted_87 = { key: 0 }
    const _hoisted_88 = {
      class: "name-column",
      "data-label": "Name"
    }
    const _hoisted_89 = {
      key: 0,
      class: "object-name-cell"
    }
    const _hoisted_90 = { class: "icon name-column-icon is-smmd" }
    const _hoisted_91 = ["href", "title", "onClick"]
    const _hoisted_92 = ["title"]
    const _hoisted_93 = ["title"]
    const _hoisted_94 = {
      key: 1,
      class: "object-name-cell"
    }
    const _hoisted_95 = ["href", "title", "onClick"]
    const _hoisted_96 = {
      class: "size-column",
      "data-label": "Size"
    }
    const _hoisted_97 = ["title"]
    const _hoisted_98 = { class: "object-size-value" }
    const _hoisted_99 = { class: "object-size-unit" }
    const _hoisted_100 = {
      key: 1,
      class: "object-size object-size-empty"
    }
    const _hoisted_101 = {
      class: "modified-column",
      "data-label": "Last modified"
    }
    const _hoisted_102 = ["title"]
    const _hoisted_103 = {
      key: 1,
      class: "object-modified object-modified-empty"
    }
    const _hoisted_104 = { class: "actions-column is-end" }
    const _hoisted_105 = { class: "row-menu-wrap" }
    const _hoisted_106 = ["data-key"]
    const _hoisted_107 = ["title", "aria-label"]
    const _hoisted_108 = { class: "bb-menu-popover" }
    const _hoisted_109 = {
      class: "bb-menu-list",
      role: "menu"
    }
    const _hoisted_110 = ["onClick"]
    const _hoisted_111 = ["onClick"]
    const _hoisted_112 = ["onClick"]
    const _hoisted_113 = ["onClick"]
    const _hoisted_114 = ["onClick"]
    const _hoisted_115 = ["onClick"]
    const _hoisted_116 = ["data-prefix"]
    const _hoisted_117 = ["title", "aria-label"]
    const _hoisted_118 = { class: "bb-menu-popover" }
    const _hoisted_119 = {
      class: "bb-menu-list",
      role: "menu"
    }
    const _hoisted_120 = ["onClick"]
    const _hoisted_121 = ["onClick"]
    const _hoisted_122 = ["onClick"]
    const _hoisted_123 = ["onClick"]
    const _hoisted_124 = ["onClick"]
    const _hoisted_125 = {
      key: 1,
      "aria-hidden": "true"
    }
    const _hoisted_126 = {
      key: 1,
      class: "table-empty browser-load-error",
      role: "alert"
    }
    const _hoisted_127 = { class: "browser-load-error-copy" }
    const _hoisted_128 = ["disabled"]
    const _hoisted_129 = {
      key: 2,
      class: "table-empty browser-empty-folder"
    }
    const _hoisted_130 = {
      key: 0,
      class: "app-footer"
    }
    const _hoisted_131 = ["title"]

    return function render(_ctx, _cache) {
      return (_openBlock(), _createElementBlock("div", _hoisted_1, [
        _createElementVNode("a", {
          class: "skip-link",
          href: "#main-content",
          onClick: _cache[0] || (_cache[0] = _withModifiers((...args) => (_ctx.focusMainContent && _ctx.focusMainContent(...args)), ["prevent"]))
        }, "Skip to the object list"),
        _createElementVNode("header", _hoisted_2, [
          _createElementVNode("div", _hoisted_3, [
            _createElementVNode("div", _hoisted_4, [
              _createElementVNode("div", _hoisted_5, [
                _createElementVNode("button", {
                  type: "button",
                  class: _normalizeClass(["root-link", { 'breadcrumb-current': !_ctx.breadcrumbs.length }]),
                  "aria-current": _ctx.breadcrumbs.length ? null : 'page',
                  "aria-disabled": _ctx.breadcrumbs.length ? 'false' : 'true',
                  tabindex: _ctx.breadcrumbs.length ? 0 : -1,
                  title: "Storage root",
                  "aria-label": "Storage root",
                  onClick: _cache[1] || (_cache[1] = $event => (_ctx.breadcrumbs.length && _ctx.goToPrefix('')))
                }, _cache[27] || (_cache[27] = [
                  _createElementVNode("i", { class: "mdi mdi-database-outline" }, null, -1 /* CACHED */)
                ]), 10 /* CLASS, PROPS */, _hoisted_6),
                _createElementVNode("h1", _hoisted_7, _toDisplayString(_ctx.pageHeading), 1 /* TEXT */),
                _createElementVNode("nav", _hoisted_8, [
                  _cache[30] || (_cache[30] = _createElementVNode("span", { class: "breadcrumb-separator" }, "/", -1 /* CACHED */)),
                  (_ctx.hiddenBreadcrumbs.length)
                    ? (_openBlock(), _createElementBlock("span", _hoisted_9, [
                        _createElementVNode("button", {
                          ref: "breadcrumbOverflowTrigger",
                          type: "button",
                          class: "breadcrumb-overflow-trigger",
                          title: `Show ${_ctx.hiddenBreadcrumbs.length} hidden parent folder${_ctx.hiddenBreadcrumbs.length === 1 ? '' : 's'}`,
                          "aria-label": "Show hidden parent folders",
                          "aria-haspopup": "menu",
                          "aria-expanded": _ctx.breadcrumbOverflowOpen ? 'true' : 'false',
                          onClick: _cache[2] || (_cache[2] = _withModifiers((...args) => (_ctx.toggleBreadcrumbOverflow && _ctx.toggleBreadcrumbOverflow(...args)), ["stop"])),
                          onKeydown: _cache[3] || (_cache[3] = _withKeys(_withModifiers((...args) => (_ctx.openBreadcrumbOverflowFromKeyboard && _ctx.openBreadcrumbOverflowFromKeyboard(...args)), ["prevent"]), ["down"]))
                        }, [
                          _cache[28] || (_cache[28] = _createElementVNode("span", {
                            class: "breadcrumb-overflow-ellipsis",
                            "aria-hidden": "true"
                          }, "…", -1 /* CACHED */)),
                          _createElementVNode("span", _hoisted_11, _toDisplayString(_ctx.hiddenBreadcrumbs.length), 1 /* TEXT */)
                        ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_10),
                        (_openBlock(), _createBlock(_Teleport, { to: "body" }, [
                          (_ctx.breadcrumbOverflowOpen)
                            ? (_openBlock(), _createElementBlock("div", {
                                key: 0,
                                ref: "breadcrumbOverflowPopover",
                                class: "breadcrumb-overflow-popover",
                                style: _normalizeStyle(_ctx.breadcrumbPopoverStyle),
                                role: "menu",
                                "aria-label": "Hidden parent folders",
                                onClick: _cache[4] || (_cache[4] = _withModifiers(() => {}, ["stop"])),
                                onKeydown: _cache[5] || (_cache[5] = (...args) => (_ctx.onBreadcrumbMenuKeydown && _ctx.onBreadcrumbMenuKeydown(...args)))
                              }, [
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.hiddenBreadcrumbs, (crumb, index) => {
                                  return (_openBlock(), _createElementBlock("button", {
                                    key: crumb.prefix,
                                    type: "button",
                                    class: "breadcrumb-overflow-item",
                                    title: crumb.prefix,
                                    role: "menuitem",
                                    onClick: $event => (_ctx.openHiddenBreadcrumb(crumb.prefix))
                                  }, [
                                    _createElementVNode("span", {
                                      class: "breadcrumb-overflow-copy",
                                      style: _normalizeStyle({ paddingLeft: `${Math.min(index, 6) * 0.65}rem` })
                                    }, [
                                      _cache[29] || (_cache[29] = _createElementVNode("span", {
                                        class: "breadcrumb-overflow-branch",
                                        "aria-hidden": "true"
                                      }, [
                                        _createElementVNode("i", { class: "mdi mdi-subdirectory-arrow-right" })
                                      ], -1 /* CACHED */)),
                                      _createElementVNode("span", _hoisted_13, [
                                        _createElementVNode("small", null, _toDisplayString(index === 0 ? 'Inside storage root' : `Inside ${_ctx.hiddenBreadcrumbs[index - 1].name}`), 1 /* TEXT */),
                                        _createElementVNode("strong", null, _toDisplayString(crumb.name), 1 /* TEXT */)
                                      ])
                                    ], 4 /* STYLE */)
                                  ], 8 /* PROPS */, _hoisted_12))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 36 /* STYLE, NEED_HYDRATION */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      ]))
                    : _createCommentVNode("v-if", true),
                  (_ctx.hiddenBreadcrumbs.length && _ctx.visibleBreadcrumbs.length)
                    ? (_openBlock(), _createElementBlock("span", _hoisted_14, "/"))
                    : _createCommentVNode("v-if", true),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleBreadcrumbs, (crumb, index) => {
                    return (_openBlock(), _createElementBlock(_Fragment, {
                      key: crumb.prefix
                    }, [
                      (_ctx.hiddenBreadcrumbs.length + index < _ctx.breadcrumbs.length - 1)
                        ? (_openBlock(), _createElementBlock("button", {
                            key: 0,
                            type: "button",
                            class: "breadcrumb-link",
                            title: crumb.prefix,
                            onClick: $event => (_ctx.goToPrefix(crumb.prefix))
                          }, _toDisplayString(crumb.name), 9 /* TEXT, PROPS */, _hoisted_15))
                        : (_openBlock(), _createElementBlock("span", {
                            key: 1,
                            class: "breadcrumb-current",
                            "aria-current": "page",
                            title: crumb.prefix
                          }, _toDisplayString(crumb.name), 9 /* TEXT, PROPS */, _hoisted_16)),
                      (index < _ctx.visibleBreadcrumbs.length - 1)
                        ? (_openBlock(), _createElementBlock("span", _hoisted_17, "/"))
                        : _createCommentVNode("v-if", true)
                    ], 64 /* STABLE_FRAGMENT */))
                  }), 128 /* KEYED_FRAGMENT */))
                ], 512 /* NEED_PATCH */)
              ], 512 /* NEED_PATCH */),
              _createElementVNode("div", _hoisted_18, [
                (_ctx.currentInstance && _ctx.instances.length > 1)
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      ref: "storageSwitcher",
                      class: _normalizeClass(["storage-switcher", ['storage-tree-switcher', { 'is-open': _ctx.storageSwitcherOpen }]])
                    }, [
                      _createElementVNode("div", _hoisted_19, [
                        _createElementVNode("button", {
                          ref: "storageSwitcherTrigger",
                          type: "button",
                          class: "storage-switcher-trigger has-bb-chevron",
                          "aria-haspopup": "true",
                          "aria-controls": "storage-switcher-popover",
                          "aria-expanded": _ctx.storageSwitcherOpen ? 'true' : 'false',
                          title: `${_ctx.currentInstance.host} / ${_ctx.currentInstance.id}. ${_ctx.permissionSummaryTitle}`,
                          onClick: _cache[6] || (_cache[6] = _withModifiers((...args) => (_ctx.toggleStorageSwitcher && _ctx.toggleStorageSwitcher(...args)), ["stop"]))
                        }, [
                          _cache[31] || (_cache[31] = _createElementVNode("i", {
                            class: "mdi mdi-database-outline storage-switcher-icon",
                            "aria-hidden": "true"
                          }, null, -1 /* CACHED */)),
                          _createElementVNode("span", _hoisted_21, [
                            _createElementVNode("strong", null, _toDisplayString(_ctx.currentInstance.host) + " / " + _toDisplayString(_ctx.currentInstance.id), 1 /* TEXT */),
                            _createElementVNode("small", null, [
                              _createTextVNode(_toDisplayString(_ctx.currentInstance.bucket), 1 /* TEXT */),
                              (_ctx.currentInstance.name !== _ctx.currentInstance.bucket)
                                ? (_openBlock(), _createElementBlock("span", _hoisted_22, " · " + _toDisplayString(_ctx.currentInstance.name), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true),
                              _createTextVNode(" · " + _toDisplayString(_ctx.currentInstance.provider.toUpperCase()), 1 /* TEXT */)
                            ])
                          ])
                        ], 8 /* PROPS */, _hoisted_20),
                        _createElementVNode("button", {
                          type: "button",
                          class: "storage-switcher-permissions",
                          "aria-label": `Storage permissions: ${_ctx.permissionSummaryTitle}. Open details.`,
                          title: `${_ctx.permissionSummaryTitle}. Open details.`,
                          onClick: _cache[7] || (_cache[7] = _withModifiers((...args) => (_ctx.showPermissionDetails && _ctx.showPermissionDetails(...args)), ["stop"]))
                        }, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.permissionStates, (item) => {
                            return (_openBlock(), _createElementBlock("span", {
                              key: item.key,
                              class: _normalizeClass(["storage-permission-dot", _ctx.capabilityClass(item.state)]),
                              title: `${item.label}: ${_ctx.capabilityLabel(item.state)}`
                            }, [
                              _createElementVNode("i", {
                                class: _normalizeClass(["mdi", `mdi-${item.icon}`]),
                                "aria-hidden": "true"
                              }, null, 2 /* CLASS */)
                            ], 10 /* CLASS, PROPS */, _hoisted_24))
                          }), 128 /* KEYED_FRAGMENT */))
                        ], 8 /* PROPS */, _hoisted_23)
                      ]),
                      _withDirectives(_createElementVNode("div", {
                        ref: "storageSwitcherPopover",
                        id: "storage-switcher-popover",
                        class: "storage-tree-popover",
                        role: "group",
                        "aria-label": "Storage hosts and buckets",
                        onClick: _cache[8] || (_cache[8] = _withModifiers(() => {}, ["stop"]))
                      }, [
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.storageHosts, (host) => {
                          return (_openBlock(), _createElementBlock("section", {
                            key: host.id,
                            class: _normalizeClass(["storage-host-group", { 'is-current-host': host.id === _ctx.currentInstance.host }])
                          }, [
                            _createElementVNode("button", {
                              type: "button",
                              class: "storage-host-row",
                              "aria-expanded": _ctx.isHostExpanded(host.id) ? 'true' : 'false',
                              onClick: _withModifiers($event => (_ctx.toggleHost(host.id)), ["stop"])
                            }, [
                              _createElementVNode("span", {
                                class: _normalizeClass(["storage-host-chevron", { 'is-expanded': _ctx.isHostExpanded(host.id) }]),
                                "aria-hidden": "true"
                              }, _cache[32] || (_cache[32] = [
                                _createElementVNode("i", { class: "mdi mdi-chevron-right" }, null, -1 /* CACHED */)
                              ]), 2 /* CLASS */),
                              _cache[33] || (_cache[33] = _createElementVNode("span", { class: "storage-host-icon" }, [
                                _createElementVNode("i", { class: "mdi mdi-database-outline" })
                              ], -1 /* CACHED */)),
                              _createElementVNode("span", _hoisted_26, [
                                _createElementVNode("strong", null, _toDisplayString(host.id), 1 /* TEXT */),
                                _createElementVNode("small", null, _toDisplayString(host.provider.toUpperCase()) + " · " + _toDisplayString(host.instances.length) + " bucket" + _toDisplayString(host.instances.length === 1 ? '' : 's'), 1 /* TEXT */)
                              ])
                            ], 8 /* PROPS */, _hoisted_25),
                            _withDirectives(_createElementVNode("div", {
                              class: "storage-bucket-list",
                              role: "group",
                              "aria-label": `${host.id} buckets`
                            }, [
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(host.instances, (instance) => {
                                return (_openBlock(), _createElementBlock("button", {
                                  key: instance.id,
                                  type: "button",
                                  class: _normalizeClass(["storage-bucket-row", { 'is-current-storage': instance.id === _ctx.instanceId }]),
                                  "aria-current": instance.id === _ctx.instanceId ? 'true' : null,
                                  onClick: $event => (_ctx.selectInstance(instance.id))
                                }, [
                                  _cache[34] || (_cache[34] = _createElementVNode("span", { class: "storage-option-icon" }, [
                                    _createElementVNode("i", { class: "mdi mdi-folder" })
                                  ], -1 /* CACHED */)),
                                  _createElementVNode("span", _hoisted_29, [
                                    _createElementVNode("span", _hoisted_30, [
                                      _createElementVNode("strong", null, _toDisplayString(instance.id), 1 /* TEXT */),
                                      _createElementVNode("span", {
                                        class: "storage-option-permissions",
                                        "aria-label": `${instance.name} permissions`
                                      }, [
                                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.permissionStatesFor(instance), (item) => {
                                          return (_openBlock(), _createElementBlock("span", {
                                            key: item.key,
                                            class: _normalizeClass(["storage-permission-dot", _ctx.capabilityClass(item.state)]),
                                            title: `${item.label}: ${_ctx.capabilityLabel(item.state)}`
                                          }, [
                                            _createElementVNode("i", {
                                              class: _normalizeClass(["mdi", `mdi-${item.icon}`])
                                            }, null, 2 /* CLASS */)
                                          ], 10 /* CLASS, PROPS */, _hoisted_32))
                                        }), 128 /* KEYED_FRAGMENT */))
                                      ], 8 /* PROPS */, _hoisted_31)
                                    ]),
                                    _createElementVNode("small", null, [
                                      _createTextVNode(_toDisplayString(instance.bucket), 1 /* TEXT */),
                                      (instance.name !== instance.bucket)
                                        ? (_openBlock(), _createElementBlock("span", _hoisted_33, " · " + _toDisplayString(instance.name), 1 /* TEXT */))
                                        : _createCommentVNode("v-if", true),
                                      (instance.rootPrefix)
                                        ? (_openBlock(), _createElementBlock("span", _hoisted_34, " · /" + _toDisplayString(instance.rootPrefix), 1 /* TEXT */))
                                        : _createCommentVNode("v-if", true)
                                    ])
                                  ]),
                                  _createElementVNode("span", _hoisted_35, [
                                    (instance.id === _ctx.instanceId)
                                      ? (_openBlock(), _createElementBlock("i", _hoisted_36))
                                      : _createCommentVNode("v-if", true)
                                  ])
                                ], 10 /* CLASS, PROPS */, _hoisted_28))
                              }), 128 /* KEYED_FRAGMENT */))
                            ], 8 /* PROPS */, _hoisted_27), [
                              [_vShow, _ctx.isHostExpanded(host.id)]
                            ])
                          ], 2 /* CLASS */))
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 512 /* NEED_PATCH */), [
                        [_vShow, _ctx.storageSwitcherOpen]
                      ])
                    ], 2 /* CLASS */))
                  : (_ctx.currentInstance)
                    ? (_openBlock(), _createElementBlock("div", _hoisted_37, [
                        _createElementVNode("div", _hoisted_38, [
                          _createElementVNode("div", {
                            class: "storage-switcher-trigger is-static",
                            title: _ctx.permissionSummaryTitle
                          }, [
                            _cache[35] || (_cache[35] = _createElementVNode("i", {
                              class: "mdi mdi-database-outline storage-switcher-icon",
                              "aria-hidden": "true"
                            }, null, -1 /* CACHED */)),
                            _createElementVNode("span", _hoisted_40, [
                              _createElementVNode("strong", null, _toDisplayString(_ctx.currentInstance.host) + " / " + _toDisplayString(_ctx.currentInstance.id), 1 /* TEXT */),
                              _createElementVNode("small", null, [
                                _createTextVNode(_toDisplayString(_ctx.currentInstance.bucket), 1 /* TEXT */),
                                (_ctx.currentInstance.name !== _ctx.currentInstance.bucket)
                                  ? (_openBlock(), _createElementBlock("span", _hoisted_41, " · " + _toDisplayString(_ctx.currentInstance.name), 1 /* TEXT */))
                                  : _createCommentVNode("v-if", true),
                                _createTextVNode(" · " + _toDisplayString(_ctx.currentInstance.provider.toUpperCase()), 1 /* TEXT */)
                              ])
                            ])
                          ], 8 /* PROPS */, _hoisted_39),
                          _createElementVNode("button", {
                            type: "button",
                            class: "storage-switcher-permissions",
                            "aria-label": `Storage permissions: ${_ctx.permissionSummaryTitle}. Open details.`,
                            title: `${_ctx.permissionSummaryTitle}. Open details.`,
                            onClick: _cache[9] || (_cache[9] = _withModifiers((...args) => (_ctx.showPermissionDetails && _ctx.showPermissionDetails(...args)), ["stop"]))
                          }, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.permissionStates, (item) => {
                              return (_openBlock(), _createElementBlock("span", {
                                key: item.key,
                                class: _normalizeClass(["storage-permission-dot", _ctx.capabilityClass(item.state)]),
                                title: `${item.label}: ${_ctx.capabilityLabel(item.state)}`
                              }, [
                                _createElementVNode("i", {
                                  class: _normalizeClass(["mdi", `mdi-${item.icon}`]),
                                  "aria-hidden": "true"
                                }, null, 2 /* CLASS */)
                              ], 10 /* CLASS, PROPS */, _hoisted_43))
                            }), 128 /* KEYED_FRAGMENT */))
                          ], 8 /* PROPS */, _hoisted_42)
                        ])
                      ]))
                    : (_openBlock(), _createElementBlock("div", _hoisted_44, _cache[36] || (_cache[36] = [
                        _createStaticVNode("<div class=\"storage-switcher-trigger is-static is-loading\"><span class=\"storage-switcher-loading-icon\"></span><span class=\"storage-switcher-copy\"><span class=\"storage-switcher-loading-line is-title\"></span><span class=\"storage-switcher-loading-line is-subtitle\"></span></span></div>", 1)
                      ])))
              ])
            ])
          ])
        ]),
        _createElementVNode("section", _hoisted_45, [
          _createElementVNode("div", _hoisted_46, [
            _createElementVNode("form", {
              class: "toolbar-left search-field",
              role: "search",
              onSubmit: _cache[11] || (_cache[11] = _withModifiers((...args) => (_ctx.searchByPrefix && _ctx.searchByPrefix(...args)), ["prevent"]))
            }, [
              _withDirectives(_createElementVNode("input", {
                "onUpdate:modelValue": _cache[10] || (_cache[10] = $event => ((_ctx.searchPrefix) = $event)),
                class: "input",
                type: "text",
                autocomplete: "off",
                spellcheck: "false",
                disabled: !_ctx.canRead,
                "aria-label": "Open a prefix in the current folder",
                placeholder: "Open a prefix in the current folder"
              }, null, 8 /* PROPS */, _hoisted_47), [
                [_vModelText, _ctx.searchPrefix]
              ]),
              _createElementVNode("button", {
                type: "submit",
                class: "btn",
                disabled: !_ctx.canRead
              }, _cache[37] || (_cache[37] = [
                _createElementVNode("i", {
                  class: "mdi mdi-magnify",
                  "aria-hidden": "true"
                }, null, -1 /* CACHED */),
                _createElementVNode("span", null, "Open", -1 /* CACHED */)
              ]), 8 /* PROPS */, _hoisted_48)
            ], 32 /* NEED_HYDRATION */),
            _createElementVNode("div", _hoisted_49, [
              _createElementVNode("button", {
                type: "button",
                class: "btn btn-icon",
                title: "Refresh",
                "aria-label": "Refresh the listing",
                disabled: !_ctx.canRead || _ctx.isRefreshing,
                onClick: _cache[12] || (_cache[12] = (...args) => (_ctx.manualRefresh && _ctx.manualRefresh(...args)))
              }, [
                _createElementVNode("i", {
                  class: _normalizeClass(["mdi mdi-refresh", { 'mdi-spin': _ctx.isRefreshing }]),
                  "aria-hidden": "true"
                }, null, 2 /* CLASS */)
              ], 8 /* PROPS */, _hoisted_50),
              _createElementVNode("div", _hoisted_51, [
                _cache[40] || (_cache[40] = _createElementVNode("button", {
                  type: "button",
                  class: "btn has-bb-chevron bb-menu-trigger",
                  "aria-haspopup": "menu",
                  "aria-expanded": "false"
                }, [
                  _createElementVNode("i", {
                    class: "mdi mdi-cogs",
                    "aria-hidden": "true"
                  }),
                  _createElementVNode("span", null, "Actions")
                ], -1 /* CACHED */)),
                _createElementVNode("div", _hoisted_52, [
                  _createElementVNode("div", _hoisted_53, [
                    _createElementVNode("button", {
                      type: "button",
                      role: "menuitem",
                      class: "bb-menu-item",
                      disabled: !_ctx.canDownloadAll,
                      onClick: _cache[13] || (_cache[13] = $event => (_ctx.canDownloadAll && _ctx.downloadAllFiles()))
                    }, _cache[38] || (_cache[38] = [
                      _createElementVNode("i", {
                        class: "mdi mdi-archive-arrow-down-outline",
                        "aria-hidden": "true"
                      }, null, -1 /* CACHED */),
                      _createElementVNode("span", null, "Download as ZIP", -1 /* CACHED */)
                    ]), 8 /* PROPS */, _hoisted_54),
                    _createElementVNode("button", {
                      type: "button",
                      role: "menuitem",
                      class: "bb-menu-item",
                      disabled: !_ctx.canRead,
                      onClick: _cache[14] || (_cache[14] = $event => (_ctx.canRead && _ctx.onCurrentInsights()))
                    }, [
                      _cache[39] || (_cache[39] = _createElementVNode("i", {
                        class: "mdi mdi-chart-box-outline",
                        "aria-hidden": "true"
                      }, null, -1 /* CACHED */)),
                      _createElementVNode("span", null, _toDisplayString(_ctx.currentInsightsLabel), 1 /* TEXT */)
                    ], 8 /* PROPS */, _hoisted_55)
                  ])
                ])
              ]),
              (_ctx.canWrite)
                ? (_openBlock(), _createElementBlock("div", _hoisted_56, [
                    _cache[43] || (_cache[43] = _createElementVNode("button", {
                      type: "button",
                      class: "btn btn-primary has-bb-chevron bb-menu-trigger",
                      "aria-haspopup": "menu",
                      "aria-expanded": "false"
                    }, [
                      _createElementVNode("i", {
                        class: "mdi mdi-plus",
                        "aria-hidden": "true"
                      }),
                      _createElementVNode("span", null, "New")
                    ], -1 /* CACHED */)),
                    _createElementVNode("div", _hoisted_57, [
                      _createElementVNode("div", _hoisted_58, [
                        _createElementVNode("button", {
                          type: "button",
                          role: "menuitem",
                          class: "bb-menu-item",
                          onClick: _cache[15] || (_cache[15] = (...args) => (_ctx.triggerUpload && _ctx.triggerUpload(...args)))
                        }, _cache[41] || (_cache[41] = [
                          _createElementVNode("i", {
                            class: "mdi mdi-file-upload-outline",
                            "aria-hidden": "true"
                          }, null, -1 /* CACHED */),
                          _createElementVNode("span", null, "Upload files", -1 /* CACHED */)
                        ])),
                        _createElementVNode("button", {
                          type: "button",
                          role: "menuitem",
                          class: "bb-menu-item",
                          onClick: _cache[16] || (_cache[16] = (...args) => (_ctx.triggerUploadDir && _ctx.triggerUploadDir(...args)))
                        }, _cache[42] || (_cache[42] = [
                          _createElementVNode("i", {
                            class: "mdi mdi-folder-upload",
                            "aria-hidden": "true"
                          }, null, -1 /* CACHED */),
                          _createElementVNode("span", null, "Upload folder", -1 /* CACHED */)
                        ]))
                      ])
                    ])
                  ]))
                : _createCommentVNode("v-if", true)
            ])
          ])
        ]),
        _createElementVNode("input", {
          type: "file",
          ref: "fileInput",
          class: "is-hidden-input",
          multiple: "",
          onChange: _cache[17] || (_cache[17] = (...args) => (_ctx.onFileInput && _ctx.onFileInput(...args)))
        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */),
        _createElementVNode("input", {
          type: "file",
          ref: "dirInput",
          class: "is-hidden-input",
          webkitdirectory: "",
          multiple: "",
          onChange: _cache[18] || (_cache[18] = (...args) => (_ctx.onDirInput && _ctx.onDirInput(...args)))
        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */),
        _withDirectives(_createElementVNode("div", _hoisted_59, [
          _createElementVNode("div", _hoisted_60, [
            _cache[45] || (_cache[45] = _createElementVNode("i", { class: "mdi mdi-cloud-upload-outline" }, null, -1 /* CACHED */)),
            _cache[46] || (_cache[46] = _createElementVNode("strong", null, "Drop files or folders to upload", -1 /* CACHED */)),
            _createElementVNode("span", null, [
              _cache[44] || (_cache[44] = _createTextVNode(" Uploading to ", -1 /* CACHED */)),
              _createElementVNode("span", _hoisted_61, "/" + _toDisplayString(_ctx.pathPrefix), 1 /* TEXT */)
            ])
          ])
        ], 512 /* NEED_PATCH */), [
          [_vShow, _ctx.isDragActive]
        ]),
        _createElementVNode("main", _hoisted_62, [
          (_ctx.isInitializing)
            ? (_openBlock(), _createElementBlock("div", _hoisted_63, _cache[47] || (_cache[47] = [
                _createElementVNode("i", { class: "mdi mdi-loading mdi-spin" }, null, -1 /* CACHED */),
                _createElementVNode("p", null, "Loading storage...", -1 /* CACHED */)
              ])))
            : (!_ctx.currentInstance)
              ? (_openBlock(), _createElementBlock("div", _hoisted_64, _cache[48] || (_cache[48] = [
                  _createElementVNode("i", { class: "mdi mdi-cloud-alert-outline" }, null, -1 /* CACHED */),
                  _createElementVNode("h2", null, "No storage instance is available", -1 /* CACHED */),
                  _createElementVNode("p", null, "No storage is configured or reachable. Check the server configuration file, then reload.", -1 /* CACHED */)
                ])))
              : (!_ctx.canRead)
                ? (_openBlock(), _createElementBlock("div", _hoisted_65, _cache[49] || (_cache[49] = [
                    _createElementVNode("i", { class: "mdi mdi-shield-lock-outline" }, null, -1 /* CACHED */),
                    _createElementVNode("h2", null, "Read access is not available", -1 /* CACHED */),
                    _createElementVNode("p", null, "This storage instance cannot list or read objects. Other actions remain hidden or disabled.", -1 /* CACHED */)
                  ])))
                : (_openBlock(), _createElementBlock("div", _hoisted_66, [
                    (_ctx.hasRows)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_67, [
                          _createElementVNode("div", _hoisted_68, [
                            _createElementVNode("div", _hoisted_69, [
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": _cache[19] || (_cache[19] = $event => ((_ctx.pageSize) = $event)),
                                "aria-label": "Items per page",
                                disabled: _ctx.isRefreshing
                              }, _cache[50] || (_cache[50] = [
                                _createElementVNode("option", { value: 50 }, "50", -1 /* CACHED */),
                                _createElementVNode("option", { value: 100 }, "100", -1 /* CACHED */),
                                _createElementVNode("option", { value: 500 }, "500", -1 /* CACHED */)
                              ]), 8 /* PROPS */, _hoisted_70), [
                                [_vModelSelect, _ctx.pageSize]
                              ])
                            ]),
                            _cache[51] || (_cache[51] = _createElementVNode("span", null, "per page", -1 /* CACHED */))
                          ]),
                          _createElementVNode("div", _hoisted_71, [
                            _createElementVNode("button", {
                              type: "button",
                              class: _normalizeClass(["btn btn-icon", { 'is-pagination-placeholder': !_ctx.hasPagination }]),
                              title: "Previous page",
                              "aria-label": "Previous page",
                              "aria-hidden": !_ctx.hasPagination ? 'true' : 'false',
                              tabindex: _ctx.hasPagination ? 0 : -1,
                              disabled: !_ctx.hasPreviousPage || _ctx.isRefreshing,
                              onClick: _cache[20] || (_cache[20] = (...args) => (_ctx.previousPage && _ctx.previousPage(...args)))
                            }, _cache[52] || (_cache[52] = [
                              _createElementVNode("i", {
                                class: "mdi mdi-chevron-left",
                                "aria-hidden": "true"
                              }, null, -1 /* CACHED */)
                            ]), 10 /* CLASS, PROPS */, _hoisted_72),
                            _createElementVNode("span", _hoisted_73, "Items " + _toDisplayString(_ctx.rangeStart) + "–" + _toDisplayString(_ctx.rangeEnd), 1 /* TEXT */),
                            _createElementVNode("button", {
                              type: "button",
                              class: _normalizeClass(["btn btn-icon", { 'is-pagination-placeholder': !_ctx.hasPagination }]),
                              title: "Next page",
                              "aria-label": "Next page",
                              "aria-hidden": !_ctx.hasPagination ? 'true' : 'false',
                              tabindex: _ctx.hasPagination ? 0 : -1,
                              disabled: !_ctx.hasNextPage || _ctx.isRefreshing,
                              onClick: _cache[21] || (_cache[21] = (...args) => (_ctx.nextPage && _ctx.nextPage(...args)))
                            }, _cache[53] || (_cache[53] = [
                              _createElementVNode("i", {
                                class: "mdi mdi-chevron-right",
                                "aria-hidden": "true"
                              }, null, -1 /* CACHED */)
                            ]), 10 /* CLASS, PROPS */, _hoisted_74)
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_75, [
                      (_ctx.hasRows || _ctx.isRefreshing)
                        ? (_openBlock(), _createElementBlock("div", {
                            key: 0,
                            class: _normalizeClass(["table-wrap", { 'is-loading': _ctx.isRefreshing }]),
                            "aria-busy": _ctx.isRefreshing ? 'true' : 'false'
                          }, [
                            _createElementVNode("table", _hoisted_77, [
                              _createElementVNode("caption", _hoisted_78, "Objects in /" + _toDisplayString(_ctx.pathPrefix), 1 /* TEXT */),
                              _createElementVNode("thead", null, [
                                _createElementVNode("tr", null, [
                                  _createElementVNode("th", {
                                    scope: "col",
                                    class: "name-column-header",
                                    "aria-sort": _ctx.navigationSortAria('name')
                                  }, [
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: _normalizeClass(["navigation-sort-button", { 'is-sortable': _ctx.navigationSortAvailable, 'is-active': _ctx.navigationSortField === 'name' }]),
                                      disabled: !_ctx.navigationSortAvailable,
                                      "aria-label": _ctx.navigationSortAvailable ? 'Sort by name' : 'Name',
                                      onClick: _cache[22] || (_cache[22] = $event => (_ctx.toggleNavigationSort('name')))
                                    }, [
                                      _cache[54] || (_cache[54] = _createElementVNode("span", null, "Name", -1 /* CACHED */)),
                                      _createElementVNode("span", {
                                        class: _normalizeClass(["navigation-sort-icon", { 'is-placeholder': !_ctx.navigationSortAvailable }]),
                                        "aria-hidden": "true"
                                      }, [
                                        (_ctx.navigationSortIcon('name'))
                                          ? (_openBlock(), _createElementBlock("i", {
                                              key: 0,
                                              class: _normalizeClass(["mdi", `mdi-${_ctx.navigationSortIcon('name')}`])
                                            }, null, 2 /* CLASS */))
                                          : _createCommentVNode("v-if", true)
                                      ], 2 /* CLASS */)
                                    ], 10 /* CLASS, PROPS */, _hoisted_80)
                                  ], 8 /* PROPS */, _hoisted_79),
                                  _createElementVNode("th", {
                                    scope: "col",
                                    class: "size-column-header",
                                    "aria-sort": _ctx.navigationSortAria('size')
                                  }, [
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: _normalizeClass(["navigation-sort-button is-numeric", { 'is-sortable': _ctx.navigationSortAvailable, 'is-active': _ctx.navigationSortField === 'size' }]),
                                      disabled: !_ctx.navigationSortAvailable,
                                      "aria-label": _ctx.navigationSortAvailable ? 'Sort by size' : 'Size',
                                      onClick: _cache[23] || (_cache[23] = $event => (_ctx.toggleNavigationSort('size')))
                                    }, [
                                      _cache[55] || (_cache[55] = _createElementVNode("span", null, "Size", -1 /* CACHED */)),
                                      _createElementVNode("span", {
                                        class: _normalizeClass(["navigation-sort-icon", { 'is-placeholder': !_ctx.navigationSortAvailable }]),
                                        "aria-hidden": "true"
                                      }, [
                                        (_ctx.navigationSortIcon('size'))
                                          ? (_openBlock(), _createElementBlock("i", {
                                              key: 0,
                                              class: _normalizeClass(["mdi", `mdi-${_ctx.navigationSortIcon('size')}`])
                                            }, null, 2 /* CLASS */))
                                          : _createCommentVNode("v-if", true)
                                      ], 2 /* CLASS */)
                                    ], 10 /* CLASS, PROPS */, _hoisted_82)
                                  ], 8 /* PROPS */, _hoisted_81),
                                  _createElementVNode("th", {
                                    scope: "col",
                                    class: "modified-column-header",
                                    "aria-sort": _ctx.navigationSortAria('dateModified')
                                  }, [
                                    _createElementVNode("div", _hoisted_84, [
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: _normalizeClass(["modified-time-toggle", { 'is-absolute': _ctx.modifiedTimeMode === 'absolute' }]),
                                        title: _ctx.modifiedTimeMode === 'relative' ? 'Show exact UTC dates' : 'Show relative times',
                                        "aria-label": _ctx.modifiedTimeMode === 'relative' ? 'Show exact UTC dates' : 'Show relative times',
                                        onClick: _cache[24] || (_cache[24] = _withModifiers((...args) => (_ctx.toggleModifiedTimeMode && _ctx.toggleModifiedTimeMode(...args)), ["stop"]))
                                      }, _cache[56] || (_cache[56] = [
                                        _createElementVNode("i", {
                                          class: "mdi mdi-clock-outline",
                                          "aria-hidden": "true"
                                        }, null, -1 /* CACHED */)
                                      ]), 10 /* CLASS, PROPS */, _hoisted_85),
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: _normalizeClass(["navigation-sort-button is-numeric", { 'is-sortable': _ctx.navigationSortAvailable, 'is-active': _ctx.navigationSortField === 'dateModified' }]),
                                        disabled: !_ctx.navigationSortAvailable,
                                        "aria-label": _ctx.navigationSortAvailable ? 'Sort by last modified' : 'Last modified',
                                        onClick: _cache[25] || (_cache[25] = $event => (_ctx.toggleNavigationSort('dateModified')))
                                      }, [
                                        _cache[57] || (_cache[57] = _createElementVNode("span", null, "Last modified", -1 /* CACHED */)),
                                        _createElementVNode("span", {
                                          class: _normalizeClass(["navigation-sort-icon", { 'is-placeholder': !_ctx.navigationSortAvailable }]),
                                          "aria-hidden": "true"
                                        }, [
                                          (_ctx.navigationSortIcon('dateModified'))
                                            ? (_openBlock(), _createElementBlock("i", {
                                                key: 0,
                                                class: _normalizeClass(["mdi", `mdi-${_ctx.navigationSortIcon('dateModified')}`])
                                              }, null, 2 /* CLASS */))
                                            : _createCommentVNode("v-if", true)
                                        ], 2 /* CLASS */)
                                      ], 10 /* CLASS, PROPS */, _hoisted_86)
                                    ])
                                  ], 8 /* PROPS */, _hoisted_83),
                                  _cache[58] || (_cache[58] = _createElementVNode("th", {
                                    scope: "col",
                                    class: "actions-column-header is-end"
                                  }, [
                                    _createElementVNode("span", { class: "sr-only" }, "Actions")
                                  ], -1 /* CACHED */))
                                ])
                              ]),
                              (_ctx.hasRows)
                                ? (_openBlock(), _createElementBlock("tbody", _hoisted_87, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visiblePathContentTableData, (row) => {
                                      return (_openBlock(), _createElementBlock("tr", {
                                        key: row.type === 'prefix' ? `p:${row.prefix}` : `k:${row.key}`
                                      }, [
                                        _createElementVNode("td", _hoisted_88, [
                                          (row.type === 'content')
                                            ? (_openBlock(), _createElementBlock("div", _hoisted_89, [
                                                _createElementVNode("span", _hoisted_90, [
                                                  _createElementVNode("i", {
                                                    class: _normalizeClass(["mdi", `mdi-${_ctx.fileRowIcon(row)}`]),
                                                    "aria-hidden": "true"
                                                  }, null, 2 /* CLASS */)
                                                ]),
                                                (_ctx.canRead)
                                                  ? (_openBlock(), _createElementBlock("a", {
                                                      key: 0,
                                                      class: "object-link",
                                                      href: _ctx.objectHref(row),
                                                      title: row.name,
                                                      onClick: $event => (_ctx.onObjectLink($event, row))
                                                    }, _toDisplayString(row.name), 9 /* TEXT, PROPS */, _hoisted_91))
                                                  : (_openBlock(), _createElementBlock("span", {
                                                      key: 1,
                                                      class: "object-link",
                                                      title: row.name
                                                    }, _toDisplayString(row.name), 9 /* TEXT, PROPS */, _hoisted_92)),
                                                (_ctx.versioningSupported && Number.isInteger(row.versionCount))
                                                  ? (_openBlock(), _createElementBlock("span", {
                                                      key: 2,
                                                      class: "object-version-count",
                                                      title: `${row.versionCount} version${row.versionCount === 1 ? '' : 's'}`
                                                    }, _toDisplayString(row.versionCount), 9 /* TEXT, PROPS */, _hoisted_93))
                                                  : _createCommentVNode("v-if", true)
                                              ]))
                                            : (_openBlock(), _createElementBlock("div", _hoisted_94, [
                                                _cache[59] || (_cache[59] = _createElementVNode("span", { class: "icon name-column-icon is-smmd" }, [
                                                  _createElementVNode("i", {
                                                    class: "mdi mdi-folder",
                                                    "aria-hidden": "true"
                                                  })
                                                ], -1 /* CACHED */)),
                                                _createElementVNode("a", {
                                                  class: "object-link",
                                                  href: _ctx.folderHref(row.prefix),
                                                  title: row.name,
                                                  onClick: $event => (_ctx.onFolderLink($event, row))
                                                }, _toDisplayString(row.name), 9 /* TEXT, PROPS */, _hoisted_95)
                                              ]))
                                        ]),
                                        _createElementVNode("td", _hoisted_96, [
                                          (row.type === 'content')
                                            ? (_openBlock(), _createElementBlock("span", {
                                                key: 0,
                                                class: "object-size",
                                                title: _ctx.formatBytes(row.size)
                                              }, [
                                                _createElementVNode("span", _hoisted_98, _toDisplayString(_ctx.formatByteParts(row.size).value), 1 /* TEXT */),
                                                _createElementVNode("span", _hoisted_99, _toDisplayString(_ctx.formatByteParts(row.size).unit), 1 /* TEXT */)
                                              ], 8 /* PROPS */, _hoisted_97))
                                            : (_openBlock(), _createElementBlock("span", _hoisted_100, _cache[60] || (_cache[60] = [
                                                _createElementVNode("span", {
                                                  class: "object-size-value",
                                                  "aria-hidden": "true"
                                                }, "–", -1 /* CACHED */),
                                                _createElementVNode("span", { class: "object-size-unit" }, null, -1 /* CACHED */),
                                                _createElementVNode("span", { class: "sr-only" }, "No size", -1 /* CACHED */)
                                              ])))
                                        ]),
                                        _createElementVNode("td", _hoisted_101, [
                                          (row.dateModified)
                                            ? (_openBlock(), _createElementBlock("span", {
                                                key: 0,
                                                class: "object-modified",
                                                title: _ctx.formatDateTime_utc(row.dateModified)
                                              }, _toDisplayString(_ctx.formatDateTime_display(row.dateModified)), 9 /* TEXT, PROPS */, _hoisted_102))
                                            : (_openBlock(), _createElementBlock("span", _hoisted_103, _cache[61] || (_cache[61] = [
                                                _createElementVNode("span", { "aria-hidden": "true" }, "–", -1 /* CACHED */),
                                                _createElementVNode("span", { class: "sr-only" }, "No date", -1 /* CACHED */)
                                              ])))
                                        ]),
                                        _createElementVNode("td", _hoisted_104, [
                                          _createElementVNode("div", _hoisted_105, [
                                            (row.type === 'content')
                                              ? (_openBlock(), _createElementBlock("div", {
                                                  key: 0,
                                                  class: "bb-menu",
                                                  "data-key": row.key
                                                }, [
                                                  _createElementVNode("button", {
                                                    type: "button",
                                                    class: "bb-kebab",
                                                    "aria-haspopup": "menu",
                                                    "aria-expanded": "false",
                                                    title: `Options for ${row.name}`,
                                                    "aria-label": `Options for ${row.name}`
                                                  }, _cache[62] || (_cache[62] = [
                                                    _createElementVNode("i", {
                                                      class: "mdi mdi-dots-vertical",
                                                      "aria-hidden": "true"
                                                    }, null, -1 /* CACHED */)
                                                  ]), 8 /* PROPS */, _hoisted_107),
                                                  _createElementVNode("div", _hoisted_108, [
                                                    _createElementVNode("div", _hoisted_109, [
                                                      (_ctx.canRead)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 0,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onRowMetadata(row))
                                                          }, _cache[63] || (_cache[63] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-information-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Details", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_110))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canRead)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 1,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onRowDownload(row))
                                                          }, _cache[64] || (_cache[64] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-download"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Download", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_111))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canRead && _ctx.versioningSupported)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 2,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onRowVersions(row))
                                                          }, _cache[65] || (_cache[65] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-source-commit"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Versions", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_112))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canCopy)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 3,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onRowCopy(row))
                                                          }, _cache[66] || (_cache[66] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-content-copy"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Copy", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_113))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canRename)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 4,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onRowRename(row))
                                                          }, _cache[67] || (_cache[67] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-rename-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Rename", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_114))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canDelete)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 5,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item danger",
                                                            onClick: $event => (_ctx.onRowDelete(row))
                                                          }, _cache[68] || (_cache[68] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-delete-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Delete", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_115))
                                                        : _createCommentVNode("v-if", true)
                                                    ])
                                                  ])
                                                ], 8 /* PROPS */, _hoisted_106))
                                              : (_openBlock(), _createElementBlock("div", {
                                                  key: 1,
                                                  class: "bb-menu",
                                                  "data-prefix": row.prefix
                                                }, [
                                                  _createElementVNode("button", {
                                                    type: "button",
                                                    class: "bb-kebab",
                                                    "aria-haspopup": "menu",
                                                    "aria-expanded": "false",
                                                    title: `Options for ${row.name}`,
                                                    "aria-label": `Options for ${row.name}`
                                                  }, _cache[69] || (_cache[69] = [
                                                    _createElementVNode("i", {
                                                      class: "mdi mdi-dots-vertical",
                                                      "aria-hidden": "true"
                                                    }, null, -1 /* CACHED */)
                                                  ]), 8 /* PROPS */, _hoisted_117),
                                                  _createElementVNode("div", _hoisted_118, [
                                                    _createElementVNode("div", _hoisted_119, [
                                                      (_ctx.canRead)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 0,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onPrefixInsights(row))
                                                          }, _cache[70] || (_cache[70] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-chart-box-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Insights", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_120))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canRead)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 1,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onPrefixDownload(row))
                                                          }, _cache[71] || (_cache[71] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-folder-download-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Download as ZIP", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_121))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canCopy)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 2,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onPrefixCopy(row))
                                                          }, _cache[72] || (_cache[72] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-content-copy"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Copy", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_122))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canRename)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 3,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item",
                                                            onClick: $event => (_ctx.onPrefixRename(row))
                                                          }, _cache[73] || (_cache[73] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-rename-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Rename", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_123))
                                                        : _createCommentVNode("v-if", true),
                                                      (_ctx.canDelete)
                                                        ? (_openBlock(), _createElementBlock("button", {
                                                            key: 4,
                                                            type: "button",
                                                            role: "menuitem",
                                                            class: "bb-menu-item danger",
                                                            onClick: $event => (_ctx.onPrefixDelete(row))
                                                          }, _cache[74] || (_cache[74] = [
                                                            _createElementVNode("i", {
                                                              "aria-hidden": "true",
                                                              class: "mdi mdi-delete-outline"
                                                            }, null, -1 /* CACHED */),
                                                            _createTextVNode(" Delete", -1 /* CACHED */)
                                                          ]), 8 /* PROPS */, _hoisted_124))
                                                        : _createCommentVNode("v-if", true)
                                                    ])
                                                  ])
                                                ], 8 /* PROPS */, _hoisted_116))
                                          ])
                                        ])
                                      ]))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                                : (_openBlock(), _createElementBlock("tbody", _hoisted_125, [
                                    (_openBlock(), _createElementBlock(_Fragment, null, _renderList(6, (n) => {
                                      return _createElementVNode("tr", {
                                        key: `skeleton-${n}`,
                                        class: "is-skeleton"
                                      }, _cache[75] || (_cache[75] = [
                                        _createElementVNode("td", { class: "name-column" }, [
                                          _createElementVNode("span", { class: "skeleton-line" })
                                        ], -1 /* CACHED */),
                                        _createElementVNode("td", { class: "size-column" }, [
                                          _createElementVNode("span", { class: "skeleton-line is-short" })
                                        ], -1 /* CACHED */),
                                        _createElementVNode("td", { class: "modified-column" }, [
                                          _createElementVNode("span", { class: "skeleton-line is-short" })
                                        ], -1 /* CACHED */),
                                        _createElementVNode("td", { class: "actions-column" }, null, -1 /* CACHED */)
                                      ]))
                                    }), 64 /* STABLE_FRAGMENT */))
                                  ]))
                            ])
                          ], 10 /* CLASS, PROPS */, _hoisted_76))
                        : (_ctx.loadError)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_126, [
                              _cache[78] || (_cache[78] = _createElementVNode("i", {
                                class: "mdi mdi-cloud-alert-outline",
                                "aria-hidden": "true"
                              }, null, -1 /* CACHED */)),
                              _createElementVNode("div", _hoisted_127, [
                                _cache[76] || (_cache[76] = _createElementVNode("strong", null, "This folder could not be loaded.", -1 /* CACHED */)),
                                _createElementVNode("span", null, _toDisplayString(_ctx.loadError), 1 /* TEXT */)
                              ]),
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn",
                                disabled: _ctx.isRefreshing,
                                onClick: _cache[26] || (_cache[26] = (...args) => (_ctx.manualRefresh && _ctx.manualRefresh(...args)))
                              }, _cache[77] || (_cache[77] = [
                                _createElementVNode("i", {
                                  class: "mdi mdi-refresh",
                                  "aria-hidden": "true"
                                }, null, -1 /* CACHED */),
                                _createElementVNode("span", null, "Try again", -1 /* CACHED */)
                              ]), 8 /* PROPS */, _hoisted_128)
                            ]))
                          : (_openBlock(), _createElementBlock("div", _hoisted_129, _cache[79] || (_cache[79] = [
                              _createElementVNode("i", { class: "mdi mdi-folder-open-outline" }, null, -1 /* CACHED */),
                              _createElementVNode("span", null, "This folder is empty.", -1 /* CACHED */)
                            ])))
                    ])
                  ]))
        ]),
        (_ctx.build && _ctx.build.display)
          ? (_openBlock(), _createElementBlock("footer", _hoisted_130, [
              _createElementVNode("span", {
                class: "build-version",
                title: `Release ${_ctx.build.version || 'dev'}${_ctx.build.commit && _ctx.build.commit !== 'unknown' ? ` · source ${_ctx.build.commit}` : ''}${_ctx.build.date ? ` · built ${_ctx.build.date}` : ''}`
              }, [
                _cache[80] || (_cache[80] = _createElementVNode("i", {
                  class: "mdi mdi-source-commit",
                  "aria-hidden": "true"
                }, null, -1 /* CACHED */)),
                _createElementVNode("span", null, _toDisplayString(_ctx.build.display), 1 /* TEXT */)
              ], 8 /* PROPS */, _hoisted_131)
            ]))
          : _createCommentVNode("v-if", true)
      ]))
    }
  })();
})();
