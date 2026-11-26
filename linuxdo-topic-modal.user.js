// ==UserScript==
// @name         Linux.do 帖子弹窗阅读器
// @namespace    https://linux.do/
// @version      1.5.5
// @description  在 Linux.do 帖子列表页点击帖子时，直接在当前页面弹窗展示完整正文（原生 Discourse 样式 + 长文折叠 + 自适应深浅色主题）、楼中楼评论（自动预加载前 3 页 + 实时自动刷新新回复）、支持直接回复主贴与楼层。
// @author       toujourser
// @match        https://linux.do/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-end
// @license MIT
// @downloadURL https://update.greasyfork.org/scripts/607220/Linuxdo%20%E5%B8%96%E5%AD%90%E5%BC%B9%E7%AA%97%E9%98%85%E8%AF%BB%E5%99%A8.user.js
// @updateURL https://update.greasyfork.org/scripts/607220/Linuxdo%20%E5%B8%96%E5%AD%90%E5%BC%B9%E7%AA%97%E9%98%85%E8%AF%BB%E5%99%A8.meta.js
// ==/UserScript==
 
(function () {
  'use strict';
 
  // 匹配 Discourse 帖子路径: /t/topic/12345, /t/slug/12345, /t/slug/12345/6
  const TOPIC_URL_RE = /^\/t\/(?:[^/]+\/)?(\d+)(?:\/(\d+))?\/?$/;
  const VISITED_STORAGE_KEY = 'ldm_visited_tids_v1';
  const DEFAULT_COLLAPSE_OP_KEY = 'ldm_default_collapse_op_v1';
  const READ_POS_STORAGE_KEY = 'ldm_read_positions_v1';
  const MAX_VISITED = 500;
  const MAX_SAVED_POSITIONS = 300;
  const READ_POS_SAVE_DEBOUNCE_MS = 280;
  const PAGE_SIZE = 20;
  const MAX_INDENT_DEPTH = 5;
  const OP_COLLAPSE_MAX_HEIGHT = 420; // 主贴正文超过此高度(px)时自动折叠，可点击展开
  const AUTO_PRELOAD_PAGES = 3; // 打开帖子后自动分批预加载前 N 页评论（保证楼中楼上下文完整）
  const AUTO_PRELOAD_INITIAL_DELAY_MS = 1500; // 第 1 页渲染后延迟再发起第 2 页请求，快速翻贴不发多余请求
  const BATCH_STEP_DELAY_MS = 1800; // 串行分批加载基础页间间隔（ms）
  const AUTO_PRELOAD_STEP_BACKOFF_MS = 800; // 自动预加载逐页递增放缓步长（ms）：第 2 页 1.5s，第 3 页 2.6s
  const BATCH_STEP_BACKOFF_MS = 400; // 手动批量合并逐页递增放缓步长（ms）
  const BATCH_MAX_STEP_DELAY_MS = 4500; // 单次逐页放缓等待上限（ms）
  const BATCH_MERGE_SIZE = 5;
  const AUTO_ALL_THRESHOLD = 10;
  const INFINITE_SCROLL_THRESHOLD_PX = 260; // 距离弹窗底部小于该距离时自动加载下一页
  const AUTO_APPEND_COOLDOWN_MS = 1800; // 自动翻页与前一次网络请求的最小间隔（ms），避免触发 429 频控
  const RATE_LIMIT_BACKOFF_MS = 12000; // 触发 429 后的默认冷却退避时长（ms）
  const TOPIC_META_FRESH_MS = 15000; // 同一话题短时间内重复打开直接复用快照，避免反复请求
  const POLL_BASE_INTERVAL_MS = 30000; // 无 MessageBus 时的兜底轮询起始间隔
  const POLL_MAX_INTERVAL_MS = 60000; // 兜底轮询最大退避间隔
  const LDM_DIAG_LOG = false; // 调试排查日志开关（需要排查时可改为 true）
 
  function ldmLog(tag, ...args) {
    if (!LDM_DIAG_LOG) return;
    try {
      console.log(`[LDM][${tag}]`, ...args);
    } catch {
      // ignore
    }
  }
 
  // 话题级缓存
  const topicMetaCache = new Map(); // tid -> topicData
  const topicMetaFetchedAt = new Map(); // tid -> timestamp(ms)
  const postByIdCache = new Map(); // `${tid}:${postId}` -> post
  const postByNumberCache = new Map(); // `${tid}:${postNumber}` -> post
  const subReplyCache = new Map(); // `${tid}:${postId}` -> { list, loaded }
  const summaryCache = new Map(); // tid -> posts[]
  const authorStreamCache = new Map(); // `${tid}:${username}` -> { stream, posts }
 
  function loadDefaultCollapseOp() {
    try {
      return localStorage.getItem(DEFAULT_COLLAPSE_OP_KEY) === '1';
    } catch {
      return false; // 默认展开全文
    }
  }
 
  function saveDefaultCollapseOp(val) {
    try {
      localStorage.setItem(DEFAULT_COLLAPSE_OP_KEY, val ? '1' : '0');
    } catch {
      // ignore
    }
  }
 
  const initialDefaultCollapseOp = loadDefaultCollapseOp();
 
  const state = {
    isOpen: false,
    tid: null,
    initialTitle: '',
    topic: null,
    opPost: null,
    // 全部回复的 post_id 流（不含 1 楼 OP）
    replyStream: [],
    // 当前模式（all / onlyAuthor）的分页流与分页切片
    activeStream: [],
    pageChunks: [],
    // 长主贴打开时的默认策略（false=默认展开，true=默认收缩，可持久化自定义）
    defaultCollapseOp: initialDefaultCollapseOp,
    // 当前帖子主贴长文是否展开
    opExpanded: !initialDefaultCollapseOp,
    // 已加载并参与构树的分页: Map<pageNum, Array<Post>>
    loadedPostsByPage: new Map(),
    // 跨页按需拉取的原楼缓存: Map<postNumber, Post>
    crossParentPosts: new Map(),
    // 精选热门回复（Discourse filter=summary）
    summaryPosts: null,
    page: 1,
    totalPages: 1,
    tab: 'all', // 'all' | 'summary'
    onlyAuthor: false,
    viewMode: 'tree', // 'tree' | 'flat'
    collapsedKeys: new Set(),
    expandedSummarySubIds: new Set(),
    // 内联回复框状态: null | { scopeKey, postNumber, username }
    replyTarget: null,
    replyDraft: '',
    replySubmitting: false,
    replyError: '',
    loading: false,
    appendLoading: false,
    prependLoading: false,
    autoLoadPaused: false,
    autoLoadError: '',
    lastAppendAt: 0,
    batchLoading: false,
    batchLabel: '',
    batchDone: 0,
    batchTotal: 0,
    batchNotice: '',
    batchCancelToken: 0,
    // 实时自动刷新状态（优先复用 Discourse MessageBus，不可用时降级为低频轮询）
    liveUpdateEnabled: true,
    liveMode: 'none', // 'messagebus' | 'polling' | 'none'
    revalidating: false,
    pendingNewCount: 0,
    pendingLatestPostNum: 0,
    requestSeq: 0,
    topicList: [],
    currentIndex: -1,
    prevBodyOverflow: '',
    // 阅读位置记忆与恢复状态
    positionReady: false,
    userHasScrolled: false,
    pendingRestoreAnchor: null,
    openExplicitPostNumber: null,
    openIsDirectPostLink: false,
  };
 
  // ==================== 样式注入（自适应 Linux.do 深/浅色主题变量） ====================
  const STYLES = `
    .ldm-visited,
    .ldm-visited .raw-topic-link {
      opacity: 0.62 !important;
    }
    /* 以纯样式隐藏/覆写未读角标，严禁 remove()/改 textContent 破坏 Ember/Glimmer DOM 树 */
    .ldm-badge-hidden {
      display: none !important;
    }
    .ldm-badge-count-override {
      font-size: 0 !important;
    }
    .ldm-badge-count-override::after {
      content: attr(data-ldm-unread);
      font-size: var(--font-down-1, 0.875rem);
    }
 
    #ldm-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      background: rgba(15, 23, 42, 0.62);
      backdrop-filter: blur(3px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 12px;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
      color: var(--primary, #1f2329);
      line-height: 1.65;
    }
    #ldm-overlay.ldm-open {
      display: flex;
      animation: ldm-fade-in 0.16s ease-out;
    }
    @keyframes ldm-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes ldm-slide-up {
      from { opacity: 0; transform: translateY(12px) scale(0.99); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
 
    #ldm-modal {
      width: min(1350px, 96vw);
      height: min(96vh, 1248px);
      background: var(--secondary, #ffffff);
      color: var(--primary, #1f2329);
      border-radius: 12px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.36);
      border: 1px solid var(--primary-low, #e5e7eb);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      outline: none;
      animation: ldm-slide-up 0.18s ease-out;
    }
 
    /* 顶部栏 */
    .ldm-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 20px;
      background: var(--secondary, #ffffff);
      border-bottom: 1px solid var(--primary-low, #e5e7eb);
    }
    .ldm-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .ldm-tag-badge {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--tertiary, #0088cc);
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.25));
      padding: 2px 8px;
      border-radius: 4px;
    }
    .ldm-header-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--primary, #1a1a1a);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ldm-header-actions {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ldm-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 32px;
      padding: 0 11px;
      font-size: 13px;
      font-weight: 500;
      color: var(--primary-high, #374151);
      background: var(--primary-very-low, #f3f4f6);
      border: 1px solid var(--primary-low, #e5e7eb);
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none !important;
      transition: all 0.15s ease;
      user-select: none;
      box-sizing: border-box;
      white-space: nowrap;
    }
    .ldm-btn:hover:not(:disabled) {
      background: var(--primary-low, #e5e7eb);
      color: var(--primary, #111827);
    }
    .ldm-btn:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .ldm-btn-sm {
      height: 28px;
      padding: 0 9px;
      font-size: 12px;
    }
    .ldm-btn-primary {
      background: var(--tertiary, #0088cc);
      border-color: var(--tertiary, #0088cc);
      color: #ffffff !important;
    }
    .ldm-btn-primary:hover:not(:disabled) {
      filter: brightness(0.92);
      color: #ffffff !important;
    }
    .ldm-btn-soft {
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
      border-color: var(--tertiary-low, rgba(0, 136, 204, 0.3));
      color: var(--tertiary, #0088cc) !important;
    }
    .ldm-btn-soft:hover:not(:disabled) {
      background: var(--tertiary-low, rgba(0, 136, 204, 0.18));
    }
    .ldm-btn-close {
      width: 32px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }
 
    /* 主滚动容器 */
    #ldm-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 18px 26px 36px;
      background: var(--primary-very-low, #f4f5f7);
    }
    #ldm-body::-webkit-scrollbar {
      width: 8px;
    }
    #ldm-body::-webkit-scrollbar-thumb {
      background: var(--primary-low-mid, #cbd5e1);
      border-radius: 4px;
    }
 
    /* 卡片容器 */
    .ldm-card {
      background: var(--secondary, #ffffff);
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 14px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      border: 1px solid var(--primary-low, #e5e7eb);
    }
    .ldm-card-comments {
      padding: 14px 20px 18px;
    }
 
    /* 主贴头部与作者信息 */
    .ldm-post-title {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.4;
      color: var(--primary, #111827);
      margin: 0 0 10px 0;
      word-break: break-word;
    }
    .ldm-topic-tags {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 14px;
    }
    .ldm-topic-tag {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 4px;
      background: var(--primary-very-low, #f3f4f6);
      color: var(--primary-high, #4b5563);
      border: 1px solid var(--primary-low, #e5e7eb);
      text-decoration: none;
    }
    .ldm-topic-tag:hover {
      color: var(--tertiary, #0088cc);
      border-color: var(--tertiary-low, rgba(0, 136, 204, 0.35));
    }
    .ldm-author-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding-bottom: 14px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--primary-low, #f0f2f5);
    }
    .ldm-author-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ldm-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--primary-low, #f0f2f5);
      border: 1px solid var(--primary-low, #e5e7eb);
      flex-shrink: 0;
    }
    .ldm-author-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ldm-author-name-line {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .ldm-author-name {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--primary, #1f2937);
      text-decoration: none;
    }
    .ldm-author-name:hover {
      color: var(--tertiary, #0088cc);
      text-decoration: underline;
    }
    .ldm-user-handle {
      font-size: 12px;
      color: var(--primary-medium, #8c8c8c);
    }
    .ldm-badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      line-height: 1.4;
      padding: 0 5px;
      border-radius: 3px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .ldm-badge-op {
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.12));
      color: var(--tertiary, #0088cc);
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.35));
    }
    .ldm-badge-staff {
      background: rgba(234, 88, 12, 0.12);
      color: #ea580c;
      border: 1px solid rgba(234, 88, 12, 0.3);
    }
    .ldm-badge-title {
      background: var(--primary-very-low, #f3f4f6);
      color: var(--primary-medium, #6b7280);
      border: 1px solid var(--primary-low, #e5e7eb);
      font-weight: 500;
    }
    .ldm-badge-cross {
      background: var(--primary-very-low, #f3f4f6);
      color: var(--primary-medium, #6b7280);
      border: 1px solid var(--primary-low, #e5e7eb);
      font-weight: 500;
    }
    .ldm-badge-sub {
      background: rgba(22, 163, 74, 0.1);
      color: #16a34a;
      border: 1px solid rgba(22, 163, 74, 0.25);
      font-weight: 500;
    }
    .ldm-submeta {
      font-size: 12px;
      color: var(--primary-medium, #8c8c8c);
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ldm-post-stats {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12.5px;
      color: var(--primary-medium, #6b7280);
    }
 
    /* 原生 Discourse .cooked 样式增强（直接复用站点自身样式并做容器安全适配） */
    .ldm-cooked {
      font-size: 15px;
      color: var(--primary, #1f2329);
      line-height: 1.72;
      word-break: break-word;
      overflow-wrap: anywhere;
      padding: 0 !important;
    }
    .ldm-cooked-main {
      font-size: 15.5px;
      line-height: 1.78;
    }
    .ldm-cooked > :first-child {
      margin-top: 0;
    }
    .ldm-cooked > :last-child {
      margin-bottom: 0;
    }
    .ldm-cooked img:not(.emoji):not(.avatar):not(.site-icon):not(.thumbnail) {
      max-width: min(100%, 880px);
      height: auto;
      border-radius: 6px;
      cursor: zoom-in;
    }
    .ldm-cooked a:not(.lightbox) img {
      cursor: pointer;
    }
    .ldm-tree-body-inner .ldm-cooked img:not(.emoji):not(.avatar):not(.site-icon) {
      max-height: 420px;
      width: auto;
    }
    .ldm-cooked img.emoji {
      width: 20px;
      height: 20px;
      vertical-align: middle;
      display: inline-block;
      cursor: default;
    }
    .ldm-cooked .lightbox-wrapper {
      display: inline-block;
      max-width: 100%;
      margin: 6px 0;
    }
    .ldm-cooked .lightbox-wrapper .meta {
      display: none;
    }
    .ldm-cooked pre {
      max-height: 520px;
      overflow: auto;
      border-radius: 6px;
    }
    .ldm-cooked iframe {
      max-width: 100%;
      border: none;
      border-radius: 8px;
      vertical-align: middle;
    }
    .ldm-cooked svg.d-icon {
      width: 1em;
      height: 1em;
      vertical-align: -0.125em;
      fill: currentColor;
    }
    .ldm-cooked table {
      max-width: 100%;
    }
    .ldm-cooked details {
      margin: 8px 0;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--primary-very-low, #f8f9fa);
      border: 1px solid var(--primary-low, #e5e7eb);
    }
    .ldm-cooked details summary {
      cursor: pointer;
      font-weight: 600;
    }
 
    /* 长主贴自动折叠与展开按钮 */
    .ldm-op-body-wrap {
      position: relative;
    }
    .ldm-op-body-wrap.ldm-op-collapsed {
      max-height: 420px;
      overflow: hidden;
    }
    .ldm-op-fade {
      display: none;
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 88px;
      pointer-events: none;
      background: linear-gradient(to bottom, rgba(0, 0, 0, 0), var(--secondary, #ffffff) 88%);
    }
    .ldm-op-body-wrap.ldm-op-collapsed .ldm-op-fade {
      display: block;
    }
    .ldm-op-toggle-bar {
      display: none;
      justify-content: center;
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px dashed var(--primary-low, #e5e7eb);
    }
    .ldm-op-toggle-bar.ldm-show {
      display: flex;
    }
    .ldm-op-toggle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 18px;
      font-size: 13px;
      font-weight: 600;
      color: var(--tertiary, #0088cc);
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.35));
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ldm-op-toggle-btn:hover {
      background: var(--tertiary-low, rgba(0, 136, 204, 0.2));
    }
 
    /* 评论控制栏 */
    .ldm-toolbar {
      position: sticky;
      top: -18px;
      z-index: 15;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      background: var(--secondary, #ffffff);
      border: 1px solid var(--primary-low, #e5e7eb);
      border-radius: 10px;
      padding: 9px 14px;
      margin-bottom: 14px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
    }
    .ldm-tabs {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
    .ldm-tab {
      padding: 5px 11px;
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-high, #4b5563);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .ldm-tab:hover {
      background: var(--primary-very-low, #f3f4f6);
      color: var(--primary, #111827);
    }
    .ldm-tab.ldm-active {
      color: var(--tertiary, #0088cc);
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
      border-color: var(--tertiary-low, rgba(0, 136, 204, 0.3));
    }
    .ldm-toolbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .ldm-seg-group {
      display: inline-flex;
      background: var(--primary-very-low, #f3f4f6);
      border-radius: 6px;
      padding: 2px;
      border: 1px solid var(--primary-low, #e5e7eb);
    }
    .ldm-seg-btn {
      border: none;
      background: transparent;
      color: var(--primary-high, #4b5563);
      font-size: 12px;
      font-weight: 600;
      padding: 3px 9px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .ldm-seg-btn.ldm-seg-active {
      background: var(--secondary, #ffffff);
      color: var(--tertiary, #0088cc);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }
 
    /* 批量合并加载进度条 */
    .ldm-batch-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 14px;
      margin-bottom: 12px;
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.08));
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.25));
      border-radius: 8px;
      font-size: 12.5px;
      color: var(--primary, #1f2937);
    }
    .ldm-batch-progress {
      flex: 1;
      height: 6px;
      background: var(--primary-low, #e5e7eb);
      border-radius: 999px;
      overflow: hidden;
      min-width: 100px;
    }
    .ldm-batch-progress-fill {
      height: 100%;
      background: var(--tertiary, #0088cc);
      transition: width 0.2s ease;
    }
    .ldm-live-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 9px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid var(--primary-low, #e5e7eb);
      background: var(--primary-very-low, #f3f4f6);
      color: var(--primary-high, #4b5563);
      cursor: pointer;
      transition: all 0.15s;
    }
    .ldm-live-pill.ldm-live-on {
      border-color: rgba(22, 163, 74, 0.35);
      background: rgba(22, 163, 74, 0.08);
      color: #15803d;
    }
    .ldm-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #9ca3af;
      flex-shrink: 0;
    }
    .ldm-live-pill.ldm-live-on .ldm-live-dot {
      background: #22c55e;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.22);
    }
    .ldm-new-replies-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 14px;
      margin-bottom: 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.35);
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--primary, #14532d);
      cursor: pointer;
      transition: background 0.15s;
    }
    .ldm-new-replies-banner:hover {
      background: rgba(34, 197, 94, 0.18);
    }
 
    /* 区块标题 */
    .ldm-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--primary-low, #f0f2f5);
    }
    .ldm-section-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--primary, #111827);
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
    }
 
    /* ==================== V2Next 风格楼中楼树 ==================== */
    .ldm-tree-node {
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
    }
    .ldm-tree-node.ldm-level-0 {
      margin-top: 0;
      padding: 12px 4px 10px;
      border-bottom: 1px solid var(--primary-low, #eef0f4);
    }
    .ldm-tree-node.ldm-level-0:last-child {
      border-bottom: none;
    }
    .ldm-tree-node.ldm-node-cross > .ldm-tree-content-wrap > .ldm-tree-right > .ldm-tree-body-inner {
      background: var(--primary-very-low, #f9fafb);
      border: 1px dashed var(--primary-low-mid, #d1d5db);
      border-radius: 6px;
      padding: 8px 12px;
      margin-top: 4px;
    }
    .ldm-small-action {
      padding: 6px 10px;
      margin: 4px 0;
      font-size: 12.5px;
      color: var(--primary-medium, #8c8c8c);
      background: var(--primary-very-low, #f8f9fb);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    @keyframes ldm-post-flash {
      0% { background-color: var(--tertiary-low, rgba(0, 136, 204, 0.22)); }
      70% { background-color: var(--tertiary-very-low, rgba(0, 136, 204, 0.1)); }
      100% { background-color: transparent; }
    }
    .ldm-post-highlight {
      border-radius: 8px;
      animation: ldm-post-flash 2.2s ease-out;
    }
 
    /* 作者行 */
    .ldm-tree-author {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 28px;
    }
    .ldm-tree-author.ldm-is-collapsed {
      cursor: pointer;
      padding: 3px 6px;
      margin: -3px -6px;
      border-radius: 6px;
      background: var(--primary-very-low, #f8f9fb);
    }
    .ldm-tree-author.ldm-is-collapsed:hover {
      background: var(--primary-low, #f1f3f6);
    }
    .ldm-tree-author-left {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .ldm-collapse-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.3));
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
      color: var(--tertiary, #0088cc);
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
    }
    .ldm-tree-avatar {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--primary-low, #f0f2f5);
      border: 1px solid var(--primary-low, #e5e7eb);
      flex-shrink: 0;
    }
    .ldm-tree-node:not(.ldm-level-0) .ldm-tree-avatar {
      width: 22px;
      height: 22px;
    }
    .ldm-tree-time {
      font-size: 12px;
      color: var(--primary-medium, #9ca3af);
    }
    .ldm-collapsed-summary {
      font-size: 12px;
      color: var(--primary-high, #6b7280);
      background: var(--primary-low, #eef2f7);
      padding: 1px 7px;
      border-radius: 999px;
    }
    .ldm-tree-author-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .ldm-floor-tag {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--primary-medium, #9ca3af);
      background: var(--primary-very-low, #f3f4f6);
      padding: 1px 6px;
      border-radius: 4px;
      font-variant-numeric: tabular-nums;
    }
    .ldm-like-pill {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(239, 68, 68, 0.1);
      color: #e11d48;
      font-weight: 600;
      font-size: 11.5px;
    }
    .ldm-reply-trigger {
      border: none;
      background: transparent;
      color: var(--primary-medium, #6b7280);
      font-size: 12px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .ldm-reply-trigger:hover {
      color: var(--tertiary, #0088cc);
      background: var(--tertiary-very-low, rgba(0, 136, 204, 0.1));
    }
 
    /* 内联回复编辑器（V2Next 风格） */
    .ldm-reply-box {
      margin: 10px 0 8px;
      padding: 12px 14px;
      background: var(--primary-very-low, #f8f9fb);
      border: 1px solid var(--tertiary-low, rgba(0, 136, 204, 0.35));
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    .ldm-reply-box-topic {
      margin: 0 0 14px;
      background: var(--secondary, #ffffff);
      padding: 14px 18px;
      border-radius: 10px;
    }
    .ldm-reply-box-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--primary, #1f2937);
    }
    .ldm-reply-textarea {
      width: 100%;
      min-height: 92px;
      max-height: 280px;
      resize: vertical;
      box-sizing: border-box;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.6;
      color: var(--primary, #1f2329);
      background: var(--secondary, #ffffff);
      border: 1px solid var(--primary-low-mid, #d1d5db);
      border-radius: 6px;
      outline: none;
      transition: border-color 0.15s;
    }
    .ldm-reply-textarea:focus {
      border-color: var(--tertiary, #0088cc);
    }
    .ldm-reply-box-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .ldm-reply-hint {
      font-size: 12px;
      color: var(--primary-medium, #8c8c8c);
    }
    .ldm-reply-error {
      margin-top: 6px;
      font-size: 12.5px;
      color: #dc2626;
      font-weight: 500;
    }
    .ldm-reply-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
 
    /* 轻量 Toast 提示 */
    #ldm-toast {
      position: absolute;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%) translateY(10px);
      z-index: 30;
      padding: 8px 16px;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.9);
      color: #ffffff;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s ease;
    }
    #ldm-toast.ldm-show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
 
    /* 左侧可点击竖线 + 右侧内容与子树 */
    .ldm-tree-content-wrap {
      display: flex;
      position: relative;
    }
    .ldm-expand-line {
      cursor: pointer;
      width: 26px;
      min-width: 26px;
      position: relative;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .ldm-tree-node:not(.ldm-level-0) > .ldm-tree-content-wrap > .ldm-expand-line {
      width: 22px;
      min-width: 22px;
    }
    .ldm-expand-line::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 2px;
      bottom: 2px;
      width: 0;
      border-right: 1.5px solid var(--primary-low, #e5e7eb);
      transform: translateX(-50%);
      transition: border-color 0.15s ease, border-width 0.15s ease;
    }
    .ldm-expand-line:hover::after {
      border-right: 2.5px solid var(--tertiary, #0088cc);
    }
    .ldm-tree-right {
      flex: 1;
      min-width: 0;
      padding-left: 8px;
    }
    .ldm-tree-body-inner {
      padding: 3px 0 4px;
    }
    .ldm-reply-to-hint {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--primary-medium, #6b7280);
      background: var(--primary-very-low, #f3f4f6);
      padding: 2px 8px;
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .ldm-inline-link-btn {
      border: none;
      background: transparent;
      color: var(--tertiary, #0088cc);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 0 2px;
      text-decoration: underline;
    }
    .ldm-inline-link-btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .ldm-tree-children {
      margin-top: 4px;
    }
    .ldm-tree-children-topwrap {
      margin-top: 6px;
      background: var(--primary-very-low, #f8f9fb);
      border: 1px solid var(--primary-low, #eceef2);
      border-radius: 8px;
      padding: 8px 12px 6px 8px;
    }
 
    /* V2Next 风格「── 共有 N 条回复 ▾」展开条 */
    .ldm-reply-count-bar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px 5px 0;
      margin-top: 2px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--primary-medium, #6b7280);
      background: transparent;
      border: none;
      cursor: pointer;
      transition: color 0.15s;
    }
    .ldm-reply-count-bar:hover:not(:disabled) {
      color: var(--tertiary, #0088cc);
    }
    .ldm-reply-count-bar:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .ldm-reply-count-bar .ldm-gang {
      display: inline-block;
      width: 22px;
      height: 0;
      border-bottom: 1.5px solid var(--primary-low-mid, #d1d5db);
      transition: border-color 0.15s;
    }
    .ldm-reply-count-bar:hover:not(:disabled) .ldm-gang {
      border-color: var(--tertiary, #0088cc);
    }
 
    /* 无限滚动状态栏与更早评论加载条 */
    .ldm-prepend-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin: 4px 0 12px;
      padding: 8px 12px;
      background: var(--primary-very-low, #f8f9fb);
      border: 1px dashed var(--primary-low-mid, #d1d5db);
      border-radius: 8px;
    }
    .ldm-prepend-btn {
      border: none;
      background: transparent;
      color: var(--tertiary, #0088cc);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 2px 6px;
    }
    .ldm-prepend-btn:hover:not(:disabled) {
      text-decoration: underline;
    }
    .ldm-prepend-btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .ldm-scroll-footer {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
      padding: 12px 14px 4px;
      border-top: 1px solid var(--primary-low, #f0f2f5);
      font-size: 12.5px;
      color: var(--primary-medium, #8c8c8c);
    }
    .ldm-scroll-footer.ldm-scroll-loading {
      color: var(--tertiary, #0088cc);
      font-weight: 500;
    }
    .ldm-scroll-footer.ldm-scroll-error {
      color: #d97706;
    }
    .ldm-scroll-footer.ldm-scroll-end {
      color: var(--primary-medium, #9ca3af);
      font-size: 12px;
      letter-spacing: 0.2px;
    }
    .ldm-spinner-sm {
      width: 15px;
      height: 15px;
      border: 2px solid var(--primary-low, #e5e7eb);
      border-top-color: var(--tertiary, #0088cc);
      border-radius: 50%;
      animation: ldm-spin 0.75s linear infinite;
      flex-shrink: 0;
    }
 
    /* 加载中与错误态 */
    .ldm-state-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 56px 20px;
      text-align: center;
      color: var(--primary-medium, #6b7280);
      gap: 12px;
    }
    .ldm-spinner {
      width: 34px;
      height: 34px;
      border: 3px solid var(--primary-low, #e5e7eb);
      border-top-color: var(--tertiary, #0088cc);
      border-radius: 50%;
      animation: ldm-spin 0.75s linear infinite;
    }
    @keyframes ldm-spin {
      to { transform: rotate(360deg); }
    }
 
    /* 回到顶部按钮 */
    #ldm-back-top {
      position: absolute;
      right: 28px;
      bottom: 24px;
      z-index: 20;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 1px solid var(--primary-low, #e5e7eb);
      background: var(--secondary, #ffffff);
      color: var(--primary-high, #374151);
      font-size: 16px;
      font-weight: 700;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    #ldm-back-top:hover {
      background: var(--tertiary, #0088cc);
      color: #ffffff;
      border-color: var(--tertiary, #0088cc);
    }
    #ldm-back-top.ldm-show {
      display: flex;
    }
 
    /* 图片灯箱 Lightbox */
    #ldm-lightbox {
      position: fixed;
      inset: 0;
      z-index: 2147483100;
      background: rgba(0, 0, 0, 0.88);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      cursor: zoom-out;
    }
    #ldm-lightbox.ldm-open {
      display: flex;
      animation: ldm-fade-in 0.14s ease-out;
    }
    #ldm-lightbox img {
      max-width: 94vw;
      max-height: 86vh;
      object-fit: contain;
      border-radius: 6px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      cursor: default;
    }
    .ldm-lightbox-bar {
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ldm-lightbox-link {
      color: #e5e7eb !important;
      font-size: 13px;
      text-decoration: underline;
    }
 
    @media (max-width: 680px) {
      #ldm-overlay {
        padding: 0;
      }
      #ldm-modal {
        width: 100vw;
        height: 100vh;
        border-radius: 0;
      }
      #ldm-body {
        padding: 12px 10px 28px;
      }
      .ldm-card {
        padding: 14px 12px;
      }
      .ldm-expand-line {
        width: 16px;
        min-width: 16px;
      }
      .ldm-tree-right {
        padding-left: 6px;
      }
    }
  `;
 
  function injectStyles(css) {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }
 
  // ==================== 工具函数 ====================
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
 
  function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed.startsWith('//')) return 'https:' + trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/')) return location.origin + trimmed;
    return '';
  }
 
  function resolveAvatar(template, size = 64) {
    if (!template) return '';
    const raw = template.replace('{size}', String(size));
    return normalizeUrl(raw);
  }
 
  function formatNumber(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0';
    if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(num);
  }
 
  function formatTimeAgo(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
 
  function getLikeCount(post) {
    if (!post || !Array.isArray(post.actions_summary)) return 0;
    const likeAction = post.actions_summary.find((a) => a.id === 2);
    return Number(likeAction?.count || 0);
  }
 
  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'MARK',
    'A', 'IMG', 'PICTURE', 'IFRAME', 'BLOCKQUOTE', 'ASIDE', 'HEADER', 'ARTICLE', 'SECTION', 'DETAILS', 'SUMMARY',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'PRE', 'CODE', 'KBD', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
    'CAPTION', 'COL', 'COLGROUP', 'FIGURE', 'FIGCAPTION', 'CENTER', 'SUP', 'SUB',
    'SMALL', 'VIDEO', 'SOURCE', 'AUDIO',
    'SVG', 'USE', 'PATH', 'G', 'RECT', 'CIRCLE', 'ELLIPSE', 'LINE', 'POLYLINE', 'POLYGON',
    'TEXT', 'TSPAN', 'DEFS', 'LINEARGRADIENT', 'RADIALGRADIENT', 'STOP', 'CLIPPATH'
  ]);
 
  const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml);/i;
 
  const ALLOWED_STYLE_PROPS = new Set([
    'color', 'background-color', 'font-weight', 'font-style', 'font-size',
    'text-decoration', 'text-align', 'text-indent', 'line-height', 'white-space',
    'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'border', 'border-left', 'border-radius', 'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
    'display', 'vertical-align', 'aspect-ratio', 'grid-template-columns', 'overflow'
  ]);
 
  const UNSAFE_STYLE_VAL_RE = /(?:url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding)/i;
 
  function sanitizeStyle(rawStyle) {
    if (!rawStyle || typeof rawStyle !== 'string') return '';
    const kept = [];
    for (const part of rawStyle.split(';')) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if (!prop || !val) continue;
      if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
      if (UNSAFE_STYLE_VAL_RE.test(val)) continue;
      kept.push(`${prop}:${val}`);
    }
    return kept.join(';');
  }
 
  /**
   * 清洗 Discourse 的 cooked HTML：
   * 完整保留 Discourse 原生排版类名（onebox / quote / hljs / emoji / lightbox / details / callout / mention），
   * 移除危险脚本和事件处理器，同时修复相对路径与新标签页打开链接。
   */
  function sanitizeCookedHtml(rawHtml) {
    if (!rawHtml) return '';
    const doc = new DOMParser().parseFromString(`<div>${rawHtml}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';
 
    function cleanNode(node) {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.COMMENT_NODE) {
          child.remove();
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
 
        const tag = child.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'OBJECT' || tag === 'EMBED') {
          if (tag === 'OBJECT' || tag === 'EMBED') {
            ldmLog('sanitize-removed-embed', { tag, html: child.outerHTML.slice(0, 200) });
          }
          child.remove();
          continue;
        }
 
        if (tag === 'IFRAME') {
          // 保留 Discourse 服务端已白名单校验的 https/同源 iframe（如红包卡片、视频等）
          const rawSrc = child.getAttribute('src') || child.getAttribute('data-src') || '';
          const safeSrc = normalizeUrl(rawSrc);
          if (!safeSrc || !/^https:\/\//i.test(safeSrc)) {
            ldmLog('sanitize-removed-iframe', { rawSrc });
            child.remove();
            continue;
          }
          child.setAttribute('src', safeSrc);
          if (!child.getAttribute('loading')) child.setAttribute('loading', 'lazy');
        }
 
        if (!ALLOWED_TAGS.has(tag)) {
          cleanNode(child);
          const frag = document.createDocumentFragment();
          while (child.firstChild) frag.appendChild(child.firstChild);
          child.replaceWith(frag);
          continue;
        }
 
        const attrs = Array.from(child.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          const val = attr.value;
 
          if (name.startsWith('on')) {
            child.removeAttribute(attr.name);
            continue;
          }
 
          if (name === 'style') {
            const safeStyle = sanitizeStyle(val);
            if (safeStyle) child.setAttribute('style', safeStyle);
            else child.removeAttribute('style');
            continue;
          }
 
          if (name === 'href' || name === 'xlink:href') {
            if (tag === 'USE') {
              // 允许 SVG sprite 本地引用 (#icon)，并统一同步到 href
              if (val.startsWith('#')) {
                if (name === 'xlink:href') {
                  child.setAttribute('href', val);
                  child.removeAttribute(attr.name);
                }
              } else {
                child.removeAttribute(attr.name);
              }
            } else if (name === 'href') {
              const safe = normalizeUrl(val);
              if (safe) {
                child.setAttribute('href', safe);
                child.setAttribute('target', '_blank');
                child.setAttribute('rel', 'noopener noreferrer');
              } else if (val.startsWith('#')) {
                // 锚点保留
              } else {
                child.removeAttribute('href');
              }
            } else {
              child.removeAttribute(attr.name);
            }
            continue;
          }
 
          if (name === 'src' || name === 'poster') {
            if (tag === 'IMG' && name === 'src' && SAFE_DATA_IMAGE_RE.test(val.trim())) {
              child.setAttribute('src', val.trim());
              continue;
            }
            const safe = normalizeUrl(val);
            if (safe) child.setAttribute(name, safe);
            else child.removeAttribute(name);
            continue;
          }
 
          if (name === 'srcset') {
            // 修复相对路径 srcset
            const fixed = val
              .split(',')
              .map((part) => {
                const segs = part.trim().split(/\s+/);
                if (!segs[0]) return '';
                const u = normalizeUrl(segs[0]);
                return u ? [u, ...segs.slice(1)].join(' ') : '';
              })
              .filter(Boolean)
              .join(', ');
            if (fixed) child.setAttribute('srcset', fixed);
            else child.removeAttribute('srcset');
            continue;
          }
 
          // 保留安全属性（class / data-* / alt / title / open / colspan / rowspan / iframe / svg 属性）
          if (
            name === 'class' ||
            name === 'alt' ||
            name === 'title' ||
            name === 'open' ||
            name === 'colspan' ||
            name === 'rowspan' ||
            name === 'loading' ||
            name === 'width' ||
            name === 'height' ||
            name === 'controls' ||
            name === 'type' ||
            name === 'media' ||
            name === 'aria-hidden' ||
            name === 'role' ||
            name === 'viewbox' ||
            name === 'd' ||
            name === 'fill' ||
            name === 'stroke' ||
            name === 'stroke-width' ||
            name === 'stroke-linecap' ||
            name === 'stroke-linejoin' ||
            name === 'opacity' ||
            name === 'transform' ||
            name === 'x' ||
            name === 'y' ||
            name === 'x1' ||
            name === 'y1' ||
            name === 'x2' ||
            name === 'y2' ||
            name === 'cx' ||
            name === 'cy' ||
            name === 'r' ||
            name === 'rx' ||
            name === 'ry' ||
            name === 'points' ||
            name === 'offset' ||
            name === 'stop-color' ||
            name === 'stop-opacity' ||
            (tag === 'IFRAME' && (
              name === 'frameborder' ||
              name === 'scrolling' ||
              name === 'allow' ||
              name === 'allowfullscreen' ||
              name === 'sandbox' ||
              name === 'referrerpolicy'
            )) ||
            name.startsWith('data-')
          ) {
            continue;
          }
 
          child.removeAttribute(attr.name);
        }
 
        if (tag === 'IMG') {
          if (!child.getAttribute('src') && !child.getAttribute('srcset')) {
            const fallbackSrc = child.getAttribute('data-src') || child.getAttribute('data-orig-src') || '';
            const safeFallback = SAFE_DATA_IMAGE_RE.test(fallbackSrc.trim())
              ? fallbackSrc.trim()
              : normalizeUrl(fallbackSrc);
            const hasPictureSource = Boolean(
              child.parentElement?.tagName?.toUpperCase() === 'PICTURE' &&
              child.parentElement.querySelector('source[srcset]')
            );
            if (safeFallback) {
              child.setAttribute('src', safeFallback);
            } else if (!hasPictureSource) {
              child.remove();
              continue;
            }
          }
          child.setAttribute('loading', 'lazy');
          const cls = child.getAttribute('class') || '';
          const isIconOrEmoji = /\b(emoji|avatar|site-icon|onebox-avatar)\b/.test(cls);
          const parentLink = child.closest('a[href]');
          const isClickableLinkImg = Boolean(parentLink && !parentLink.classList.contains('lightbox'));
          if (!isIconOrEmoji && !isClickableLinkImg) {
            child.setAttribute('class', `${cls} ldm-zoomable-img`.trim());
          }
        }
 
        if (tag === 'VIDEO' || tag === 'AUDIO') {
          child.setAttribute('controls', '');
          child.setAttribute('playsinline', '');
        }
 
        cleanNode(child);
      }
    }
 
    cleanNode(root);
    return root.innerHTML;
  }
 
  // ==================== 已读帖子记录 ====================
  function loadVisitedSet() {
    try {
      const raw = localStorage.getItem(VISITED_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      return new Set();
    }
  }
 
  const visitedTids = loadVisitedSet();
 
  function markVisited(tid) {
    if (!tid) return;
    const key = String(tid);
    visitedTids.delete(key);
    visitedTids.add(key);
    if (visitedTids.size > MAX_VISITED) {
      const first = visitedTids.values().next().value;
      visitedTids.delete(first);
    }
    try {
      localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(Array.from(visitedTids)));
    } catch {
      // ignore
    }
    applyVisitedStyles();
  }

  // ==================== 阅读位置记忆与恢复（localStorage + 内存兜底） ====================
  const readPositionsMemory = new Map();
  let savePosTimer = null;
  let isProgrammaticScroll = false;
  let programmaticScrollRaf = null;

  function loadAllReadPositions() {
    try {
      const raw = localStorage.getItem(READ_POS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function getSavedReadPosition(tid) {
    if (!tid) return null;
    const key = String(tid);
    const all = loadAllReadPositions();
    const fromStorage = all[key];
    const fromMem = readPositionsMemory.get(key);
    if (fromStorage && fromMem) {
      return (fromStorage.updatedAt || 0) >= (fromMem.updatedAt || 0) ? fromStorage : fromMem;
    }
    return fromStorage || fromMem || null;
  }

  function persistReadPositionEntry(tid, entry) {
    if (!tid || !entry) return;
    const key = String(tid);
    readPositionsMemory.set(key, entry);
    if (readPositionsMemory.size > MAX_SAVED_POSITIONS) {
      const oldestKey = readPositionsMemory.keys().next().value;
      readPositionsMemory.delete(oldestKey);
    }
    try {
      const all = loadAllReadPositions();
      all[key] = entry;
      const keys = Object.keys(all);
      if (keys.length > MAX_SAVED_POSITIONS) {
        keys
          .sort((a, b) => Number(all[a]?.updatedAt || 0) - Number(all[b]?.updatedAt || 0))
          .slice(0, keys.length - MAX_SAVED_POSITIONS)
          .forEach((k) => delete all[k]);
      }
      localStorage.setItem(READ_POS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // ignore quota / privacy errors; memory cache still works for this session
    }
  }

  function getPostOwnBounds(el) {
    const rect = el.getBoundingClientRect();
    if (el.id === 'ldm-op-article' || el.classList.contains('ldm-small-action')) {
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }
    const contentWrap = el.querySelector(':scope > .ldm-tree-content-wrap');
    if (!contentWrap) {
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }
    const bodyInner = contentWrap.querySelector(':scope > .ldm-tree-right > .ldm-tree-body-inner');
    const ownBottom = bodyInner ? bodyInner.getBoundingClientRect().bottom : rect.bottom;
    return {
      top: rect.top,
      bottom: Math.max(rect.top, ownBottom),
      height: Math.max(0, ownBottom - rect.top),
    };
  }

  function getStickyToolbarOffset() {
    const toolbar = bodyEl?.querySelector('#ldm-comments-anchor');
    const h = toolbar ? toolbar.getBoundingClientRect().height : 52;
    return Math.max(44, Math.round(h)) + 14;
  }

  function captureViewportAnchor() {
    if (!bodyEl || !state.isOpen) return null;
    const bodyRect = bodyEl.getBoundingClientRect();
    if (bodyRect.height <= 0) return null;

    const scrollTop = Math.round(bodyEl.scrollTop);
    if (scrollTop <= 8) {
      return {
        postNumber: 1,
        postId: state.opPost?.id ? Number(state.opPost.id) : null,
        anchorOffset: 18 - scrollTop,
        scrollTop,
      };
    }

    const toolbar = bodyEl.querySelector('#ldm-comments-anchor');
    const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
    const isToolbarStuck = Boolean(toolbarRect && toolbarRect.top <= bodyRect.top + 8);
    const readingLineY = bodyRect.top + (isToolbarStuck ? toolbarRect.height + 10 : 16);

    const candidates = bodyEl.querySelectorAll(
      '#ldm-op-article[data-pnum], .ldm-tree-node[data-pnum], .ldm-small-action[data-pnum]'
    );

    let spanningCandidate = null;
    let firstBelowCandidate = null;
    let lastAboveCandidate = null;

    for (const el of candidates) {
      if (el.classList.contains('ldm-node-cross') && el.querySelector('[data-action="load-cross-parent"]')) {
        continue;
      }
      const pnum = parseInt(el.getAttribute('data-pnum'), 10);
      if (!Number.isFinite(pnum) || pnum < 1) continue;

      const bounds = getPostOwnBounds(el);
      if (bounds.height <= 0) continue;

      if (bounds.top <= readingLineY && bounds.bottom > readingLineY) {
        spanningCandidate = { el, pnum, top: bounds.top };
      } else if (bounds.top > readingLineY) {
        if (!firstBelowCandidate || bounds.top < firstBelowCandidate.top) {
          firstBelowCandidate = { el, pnum, top: bounds.top };
        }
      } else if (bounds.bottom <= readingLineY) {
        if (!lastAboveCandidate || bounds.bottom > lastAboveCandidate.bottom) {
          lastAboveCandidate = { el, pnum, top: bounds.top, bottom: bounds.bottom };
        }
      }
    }

    const chosen = spanningCandidate || firstBelowCandidate || lastAboveCandidate;
    if (!chosen) {
      return {
        postNumber: 1,
        postId: state.opPost?.id ? Number(state.opPost.id) : null,
        anchorOffset: null,
        scrollTop,
      };
    }

    const cachedPost = chosen.pnum === 1
      ? state.opPost
      : (postByNumberCache.get(`${state.tid}:${chosen.pnum}`) || state.crossParentPosts.get(chosen.pnum));

    return {
      postNumber: chosen.pnum,
      postId: cachedPost?.id ? Number(cachedPost.id) : null,
      anchorOffset: Math.round(chosen.top - bodyRect.top),
      scrollTop,
    };
  }

  function findPostElementInModal(postNumber, { allowNearest = false } = {}) {
    if (!bodyEl) return { el: null, actualPostNumber: null, exact: false };
    const targetNum = Number(postNumber);
    if (!Number.isFinite(targetNum) || targetNum < 1) {
      return { el: null, actualPostNumber: null, exact: false };
    }
    if (targetNum === 1) {
      const opEl = bodyEl.querySelector('#ldm-op-article[data-pnum="1"]');
      return { el: opEl, actualPostNumber: opEl ? 1 : null, exact: Boolean(opEl) };
    }

    const exactCandidates = bodyEl.querySelectorAll(
      `.ldm-tree-node[data-pnum="${targetNum}"], .ldm-small-action[data-pnum="${targetNum}"]`
    );
    for (const el of exactCandidates) {
      if (!(el.classList.contains('ldm-node-cross') && el.querySelector('[data-action="load-cross-parent"]'))) {
        return { el, actualPostNumber: targetNum, exact: true };
      }
    }

    if (!allowNearest) {
      return { el: null, actualPostNumber: null, exact: false };
    }

    let nearestGe = null;
    let nearestLt = null;
    const allNodes = bodyEl.querySelectorAll('.ldm-tree-node[data-pnum], .ldm-small-action[data-pnum]');
    for (const el of allNodes) {
      if (el.classList.contains('ldm-node-cross') && el.querySelector('[data-action="load-cross-parent"]')) {
        continue;
      }
      const pnum = parseInt(el.getAttribute('data-pnum'), 10);
      if (!Number.isFinite(pnum) || pnum <= 1) continue;
      if (pnum >= targetNum) {
        if (!nearestGe || pnum < nearestGe.pnum) nearestGe = { el, pnum };
      } else if (!nearestLt || pnum > nearestLt.pnum) {
        nearestLt = { el, pnum };
      }
    }
    const fallback = nearestGe || nearestLt;
    return fallback
      ? { el: fallback.el, actualPostNumber: fallback.pnum, exact: false }
      : { el: null, actualPostNumber: null, exact: false };
  }

  function setBodyScrollTopProgrammatic(nextTop) {
    if (!bodyEl) return;
    isProgrammaticScroll = true;
    bodyEl.scrollTop = Math.max(0, nextTop);
    if (backTopBtnEl) {
      backTopBtnEl.classList.toggle('ldm-show', bodyEl.scrollTop > 360);
    }
    if (programmaticScrollRaf) cancelAnimationFrame(programmaticScrollRaf);
    programmaticScrollRaf = requestAnimationFrame(() => {
      programmaticScrollRaf = null;
      isProgrammaticScroll = false;
    });
  }

  function alignToAnchor(anchor, { allowNearest = false, defaultOffset = null, highlight = false } = {}) {
    if (!bodyEl || !anchor || !anchor.postNumber) return { ok: false, actualPostNumber: null };

    const { el, actualPostNumber, exact } = findPostElementInModal(anchor.postNumber, { allowNearest });
    if (!el) return { ok: false, actualPostNumber: null };

    const bodyRect = bodyEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const desiredOffset = (exact && Number.isFinite(anchor.anchorOffset))
      ? anchor.anchorOffset
      : (defaultOffset != null ? defaultOffset : getStickyToolbarOffset());

    const nextTop = Math.max(0, bodyEl.scrollTop + (elRect.top - bodyRect.top) - desiredOffset);
    setBodyScrollTopProgrammatic(nextTop);

    if (highlight && actualPostNumber > 1) {
      el.classList.remove('ldm-post-highlight');
      void el.offsetWidth;
      el.classList.add('ldm-post-highlight');
    }

    return { ok: true, actualPostNumber, exact, desiredOffset };
  }

  function saveCurrentReadPosition() {
    if (savePosTimer) {
      clearTimeout(savePosTimer);
      savePosTimer = null;
    }
    if (!state.isOpen || !state.tid || !state.topic || !state.opPost || !state.positionReady || state.loading) {
      return;
    }
    const anchor = captureViewportAnchor();
    if (!anchor) return;

    const isNormalAll = state.tab === 'all' && !state.onlyAuthor;
    const loadedPages = isNormalAll
      ? Array.from(state.loadedPostsByPage.keys()).sort((a, b) => a - b)
      : null;
    const serverLastRead = Math.max(
      Number(state.topic?.last_read_post_number || 0),
      String(readTracker.tid) === String(state.tid) ? Number(readTracker.maxReportedPostNum || 0) : 0
    );

    const entry = {
      tid: String(state.tid),
      postNumber: anchor.postNumber,
      postId: anchor.postId,
      anchorOffset: anchor.anchorOffset,
      scrollTop: anchor.scrollTop,
      page: isNormalAll ? state.page : null,
      loadedPages,
      opExpanded: Boolean(state.opExpanded),
      serverLastRead,
      updatedAt: Date.now(),
    };

    persistReadPositionEntry(state.tid, entry);
  }

  function scheduleSaveReadPosition() {
    if (!state.isOpen || !state.tid || !state.positionReady || state.loading || isProgrammaticScroll) return;
    if (savePosTimer) clearTimeout(savePosTimer);
    savePosTimer = setTimeout(() => {
      savePosTimer = null;
      saveCurrentReadPosition(true);
    }, READ_POS_SAVE_DEBOUNCE_MS);
  }
 
  function extractTopicFromAnchor(anchor) {
    if (!anchor) return null;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.hostname !== 'linux.do') return null;
      const m = url.pathname.match(TOPIC_URL_RE);
      if (!m) return null;
      return {
        tid: m[1],
        postNumber: m[2] ? parseInt(m[2], 10) : null,
        url: url.href,
      };
    } catch {
      return null;
    }
  }
 
  function applyVisitedStyles() {
    if (TOPIC_URL_RE.test(location.pathname)) return;
    const links = document.querySelectorAll('.topic-list a.raw-topic-link, .topic-list a.title, .latest-topic-list-item a.title');
    for (const a of links) {
      if (a.closest('#ldm-overlay')) continue;
      const info = extractTopicFromAnchor(a);
      if (info && visitedTids.has(info.tid)) {
        a.classList.add('ldm-visited');
      }
    }
  }
 
  function collectPageTopicList() {
    const seen = new Set();
    const list = [];
    const selectors = [
      '.topic-list a.raw-topic-link',
      '.topic-list a.title',
      '.latest-topic-list-item a.title',
      '.top-topic-list a.title',
    ];
    const anchors = document.querySelectorAll(selectors.join(','));
    for (const a of anchors) {
      if (a.closest('#ldm-overlay')) continue;
      const info = extractTopicFromAnchor(a);
      if (!info || seen.has(info.tid)) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      seen.add(info.tid);
      list.push({
        tid: info.tid,
        title: text,
        url: `https://linux.do/t/topic/${info.tid}`,
      });
    }
    return list;
  }
 
  // ==================== Discourse JSON API ====================
  let lastApiRequestAt = 0;
  let globalRateLimitUntil = 0;
 
  function parseRetryAfterMs(resp) {
    const raw = resp?.headers?.get?.('retry-after');
    if (!raw) return RATE_LIMIT_BACKOFF_MS;
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.max(5000, Math.min(60000, Math.round(sec * 1000)));
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) return Math.max(5000, Math.min(60000, diff));
    }
    return RATE_LIMIT_BACKOFF_MS;
  }
 
  async function apiGetJson(path) {
    lastApiRequestAt = Date.now();
    const resp = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      let retryAfterMs = 0;
      if (resp.status === 403 || resp.status === 401) {
        msg = '无权限或需要登录后查看该帖子';
      } else if (resp.status === 429) {
        retryAfterMs = parseRetryAfterMs(resp);
        globalRateLimitUntil = Math.max(globalRateLimitUntil, Date.now() + retryAfterMs);
        msg = '请求过于频繁，请稍候片刻再试 (429)';
      }
      const err = new Error(msg);
      err.status = resp.status;
      if (retryAfterMs) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    return resp.json();
  }
 
  function clearTopicCaches(tid, clearPosts = false) {
    const prefix = `${tid}:`;
    topicMetaCache.delete(tid);
    topicMetaFetchedAt.delete(tid);
    summaryCache.delete(tid);
    for (const k of Array.from(authorStreamCache.keys())) {
      if (k.startsWith(prefix)) authorStreamCache.delete(k);
    }
    if (clearPosts) {
      for (const k of Array.from(postByIdCache.keys())) {
        if (k.startsWith(prefix)) postByIdCache.delete(k);
      }
      for (const k of Array.from(postByNumberCache.keys())) {
        if (k.startsWith(prefix)) postByNumberCache.delete(k);
      }
      for (const k of Array.from(subReplyCache.keys())) {
        if (k.startsWith(prefix)) subReplyCache.delete(k);
      }
    }
  }
 
  function registerPostsInCache(tid, posts) {
    if (!Array.isArray(posts)) return;
    for (const p of posts) {
      if (!p || !p.id) continue;
      postByIdCache.set(`${tid}:${p.id}`, p);
      if (p.post_number != null) {
        postByNumberCache.set(`${tid}:${p.post_number}`, p);
      }
    }
  }
 
  async function fetchTopicInitial(tid, forceRefresh = false) {
    if (!forceRefresh && topicMetaCache.has(tid)) {
      return topicMetaCache.get(tid);
    }
    const data = await apiGetJson(`/t/${encodeURIComponent(tid)}.json?include_raw=false`);
    const posts = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
    registerPostsInCache(tid, posts);
    topicMetaCache.set(tid, data);
    topicMetaFetchedAt.set(tid, Date.now());
    return data;
  }
 
  async function fetchPostsByIds(tid, postIds, forceRefresh = false) {
    const result = [];
    const missing = [];
    for (const id of postIds) {
      const cached = !forceRefresh ? postByIdCache.get(`${tid}:${id}`) : null;
      if (cached) result.push(cached);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const query = missing.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
      const data = await apiGetJson(`/t/${encodeURIComponent(tid)}/posts.json?${query}`);
      const fetched = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
      registerPostsInCache(tid, fetched);
      const fetchedMap = new Map(fetched.map((p) => [Number(p.id), p]));
      for (const id of missing) {
        const p = fetchedMap.get(Number(id));
        if (p) result.push(p);
      }
    }
    // 按 postIds 原始顺序返回
    const orderMap = new Map(postIds.map((id, i) => [Number(id), i]));
    result.sort((a, b) => (orderMap.get(Number(a.id)) ?? 0) - (orderMap.get(Number(b.id)) ?? 0));
    return result;
  }
 
  async function fetchPostByNumber(tid, postNumber) {
    const cached = postByNumberCache.get(`${tid}:${postNumber}`);
    if (cached) return cached;
    const data = await apiGetJson(`/posts/by_number/${encodeURIComponent(tid)}/${encodeURIComponent(postNumber)}.json`);
    if (data && data.id) {
      registerPostsInCache(tid, [data]);
      return data;
    }
    throw new Error('未找到该楼层');
  }
 
  async function fetchPostDirectReplies(tid, postId) {
    const key = `${tid}:${postId}`;
    const cached = subReplyCache.get(key);
    if (cached && cached.loaded) return cached;
    const list = await apiGetJson(`/posts/${encodeURIComponent(postId)}/replies.json`);
    const safeList = Array.isArray(list) ? list : [];
    registerPostsInCache(tid, safeList);
    const entry = { list: safeList, loaded: true };
    subReplyCache.set(key, entry);
    return entry;
  }
 
  async function fetchTopicSummary(tid, forceRefresh = false) {
    if (!forceRefresh && summaryCache.has(tid)) {
      return summaryCache.get(tid);
    }
    const data = await apiGetJson(`/t/${encodeURIComponent(tid)}.json?filter=summary`);
    const posts = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
    registerPostsInCache(tid, posts);
    // 排除 1 楼 OP，仅保留精彩评论
    const replies = posts.filter((p) => Number(p.post_number) > 1);
    summaryCache.set(tid, replies);
    return replies;
  }
 
  async function fetchAuthorFilteredStream(tid, username, forceRefresh = false) {
    const key = `${tid}:${username}`;
    if (!forceRefresh && authorStreamCache.has(key)) {
      return authorStreamCache.get(key);
    }
    const data = await apiGetJson(`/t/${encodeURIComponent(tid)}.json?username_filters=${encodeURIComponent(username)}`);
    const posts = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
    const stream = Array.isArray(data?.post_stream?.stream) ? data.post_stream.stream : [];
    registerPostsInCache(tid, posts);
    // 排除 OP 1 楼
    const opId = state.opPost?.id;
    const replyStream = stream.filter((id) => Number(id) !== Number(opId));
    const entry = { stream: replyStream, posts: posts.filter((p) => Number(p.post_number) > 1) };
    authorStreamCache.set(key, entry);
    return entry;
  }
 
  async function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    const data = await apiGetJson('/session/csrf.json');
    return data?.csrf || '';
  }
 
  async function submitDiscourseReply({ tid, raw, replyToPostNumber = null }) {
    const csrf = await getCsrfToken();
    if (!csrf) {
      throw new Error('未能获取 CSRF Token，请确认已登录 Linux.do');
    }
    const payload = {
      topic_id: Number(tid),
      raw: String(raw || '').trim(),
      archetype: 'regular',
      nested_post: true,
    };
    if (replyToPostNumber && Number(replyToPostNumber) > 1) {
      payload.reply_to_post_number = Number(replyToPostNumber);
    }
 
    const resp = await fetch('/posts.json', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    });
 
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const apiErrors = Array.isArray(data?.errors) && data.errors.length ? data.errors.join('；') : '';
      let msg = apiErrors;
      if (!msg) {
        if (resp.status === 401 || resp.status === 403) msg = '请先登录 Linux.do 或确认拥有回复权限';
        else if (resp.status === 429) msg = '回复过于频繁，请稍候片刻再试 (429)';
        else msg = `发送失败 (HTTP ${resp.status})`;
      }
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
 
    const post = data?.post || data;
    if (post && post.id) {
      registerPostsInCache(tid, [post]);
    }
    return post;
  }
 
  // ==================== 楼中楼树构建引擎（兼容单页、多页合并与跨页原楼） ====================
  function getLoadedPostsFlat() {
    const pages = Array.from(state.loadedPostsByPage.keys()).sort((a, b) => a - b);
    const seen = new Set();
    const flat = [];
    for (const p of pages) {
      const items = state.loadedPostsByPage.get(p) || [];
      for (const item of items) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        flat.push({ ...item, _page: p });
      }
    }
    return flat;
  }
 
  function getLoadedPageRange() {
    const pages = Array.from(state.loadedPostsByPage.keys()).sort((a, b) => a - b);
    if (!pages.length) return { pages: [], min: state.page, max: state.page };
    return { pages, min: pages[0], max: pages[pages.length - 1] };
  }
 
  function countDescendants(node) {
    let total = 0;
    for (const c of node.children) {
      total += 1 + countDescendants(c);
    }
    return total;
  }
 
  function buildCommentTree(flatPosts, tid) {
    // 以 post_number 为主键构建节点表（Discourse 用 reply_to_post_number 精确指向父楼层）
    const nodeByNum = new Map();
    const insertionOrder = [];
 
    function upsertNode(raw, meta = {}) {
      const pNum = Number(raw.post_number);
      if (!pNum || pNum <= 1) return null;
      const existing = nodeByNum.get(pNum);
      if (existing) {
        if (existing._isPlaceholder && !meta._isPlaceholder) {
          Object.assign(existing, raw, {
            _isPlaceholder: false,
            _isCrossParent: Boolean(meta._isCrossParent),
            _page: meta._page ?? existing._page,
            _fromSubApi: Boolean(meta._fromSubApi),
          });
        } else if (meta._page != null && existing._page == null) {
          existing._page = meta._page;
        }
        return existing;
      }
 
      const node = {
        ...raw,
        post_number: pNum,
        _page: meta._page ?? null,
        _isPlaceholder: Boolean(meta._isPlaceholder),
        _isCrossParent: Boolean(meta._isCrossParent),
        _fromSubApi: Boolean(meta._fromSubApi),
        _order: insertionOrder.length,
        children: [],
        _parentNum: null,
      };
      nodeByNum.set(pNum, node);
      insertionOrder.push(node);
      return node;
    }
 
    // 1. 注册当前已加载分页的真实评论
    for (const p of flatPosts) {
      upsertNode(p, { _page: p._page, _isPlaceholder: false });
    }
 
    // 1.5 注册跨页引用父楼：如果缓存中已有完整内容则直接作为真实跨页原楼节点，否则生成可点击加载的轻量占位父节点
    for (const p of flatPosts) {
      const parentNum = Number(p.reply_to_post_number || 0);
      if (parentNum > 1 && parentNum !== Number(p.post_number) && !nodeByNum.has(parentNum)) {
        const childNode = nodeByNum.get(Number(p.post_number));
        const cachedFull = state.crossParentPosts.get(parentNum) || postByNumberCache.get(`${tid}:${parentNum}`);
        if (cachedFull) {
          const parentNode = upsertNode(cachedFull, { _isCrossParent: true, _isPlaceholder: false });
          if (parentNode && childNode) parentNode._order = childNode._order - 0.5;
        } else {
          const placeholder = upsertNode({
            id: `placeholder-${parentNum}`,
            post_number: parentNum,
            username: p.reply_to_user?.username || `第 ${parentNum} 楼`,
            name: p.reply_to_user?.name || '',
            avatar_template: p.reply_to_user?.avatar_template || '',
            cooked: '',
            reply_count: 0,
            post_type: 1,
          }, { _isPlaceholder: true, _isCrossParent: true });
          if (placeholder && childNode) placeholder._order = childNode._order - 0.5;
        }
      }
    }
 
    // 2. 递归合入通过 /posts/{id}/replies.json 展开的楼中楼子评论
    const visitedIds = new Set();
    const queue = Array.from(nodeByNum.values()).filter((n) => !n._isPlaceholder && n.id);
    while (queue.length) {
      const parentNode = queue.shift();
      const pidKey = String(parentNode.id);
      if (visitedIds.has(pidKey)) continue;
      visitedIds.add(pidKey);
 
      const subEntry = subReplyCache.get(`${tid}:${pidKey}`);
      if (subEntry && subEntry.loaded && Array.isArray(subEntry.list)) {
        for (const subItem of subEntry.list) {
          const subNode = upsertNode(subItem, { _fromSubApi: true });
          if (subNode) {
            if (!subNode.reply_to_post_number || Number(subNode.reply_to_post_number) <= 1) {
              subNode.reply_to_post_number = parentNode.post_number;
            }
            queue.push(subNode);
          }
        }
      }
    }
 
    // 3. 构建父子关系
    const allNodes = Array.from(nodeByNum.values());
    const roots = [];
 
    function createsCycle(childNum, candidateParentNum) {
      let cur = candidateParentNum;
      let guard = 0;
      while (cur && guard < 100) {
        if (cur === childNum) return true;
        const p = nodeByNum.get(cur);
        cur = p ? p._parentNum : null;
        guard++;
      }
      return false;
    }
 
    for (const node of allNodes) {
      const parentNum = Number(node.reply_to_post_number || 0);
      if (parentNum > 1 && parentNum !== node.post_number) {
        const parent = nodeByNum.get(parentNum);
        if (parent && !createsCycle(node.post_number, parent.post_number)) {
          node._parentNum = parent.post_number;
          parent.children.push(node);
          continue;
        }
      }
      roots.push(node);
    }
 
    const seenRoots = new Set();
    const uniqueRoots = [];
    for (const r of roots) {
      if (!r._parentNum && !seenRoots.has(r.post_number)) {
        seenRoots.add(r.post_number);
        uniqueRoots.push(r);
      }
    }
 
    function sortChildren(list) {
      list.sort((a, b) => a.post_number - b.post_number);
      for (const item of list) {
        if (item.children.length) sortChildren(item.children);
      }
    }
 
    uniqueRoots.sort((a, b) => a._order - b._order);
    for (const r of uniqueRoots) {
      if (r.children.length) sortChildren(r.children);
    }
 
    return uniqueRoots;
  }
 
  function buildSubTreeForSummary(rootPost, tid) {
    const rootNode = {
      ...rootPost,
      post_number: Number(rootPost.post_number),
      _page: null,
      _isPlaceholder: false,
      _isCrossParent: false,
      _fromSubApi: false,
      _order: 0,
      children: [],
      _parentNum: null,
    };
 
    const nodeByNum = new Map([[rootNode.post_number, rootNode]]);
    const queue = [rootNode];
    const visited = new Set();
 
    while (queue.length) {
      const parentNode = queue.shift();
      const pid = String(parentNode.id);
      if (visited.has(pid)) continue;
      visited.add(pid);
 
      const subEntry = subReplyCache.get(`${tid}:${pid}`);
      if (subEntry && Array.isArray(subEntry.list) && subEntry.list.length > 0) {
        for (const item of subEntry.list) {
          const pNum = Number(item.post_number);
          if (!pNum || nodeByNum.has(pNum)) continue;
          const childNode = {
            ...item,
            post_number: pNum,
            _page: null,
            _isPlaceholder: false,
            _isCrossParent: false,
            _fromSubApi: true,
            _order: nodeByNum.size,
            children: [],
            _parentNum: parentNode.post_number,
          };
          nodeByNum.set(pNum, childNode);
          parentNode.children.push(childNode);
          queue.push(childNode);
        }
      }
    }
 
    return rootNode;
  }
 
  // ==================== 弹窗 DOM 创建 ====================
  let overlayEl = null;
  let headerTagEl = null;
  let headerTitleEl = null;
  let prevBtnEl = null;
  let nextBtnEl = null;
  let replyTopicBtnEl = null;
  let openTabLinkEl = null;
  let bodyEl = null;
  let backTopBtnEl = null;
  let toastEl = null;
  let toastTimer = null;
  let lightboxEl = null;
  let lightboxImgEl = null;
  let lightboxLinkEl = null;
 
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('ldm-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('ldm-show');
    }, 2400);
  }
 
  function ensureModalDOM() {
    if (overlayEl) return;
 
    overlayEl = document.createElement('div');
    overlayEl.id = 'ldm-overlay';
    overlayEl.innerHTML = `
      <div id="ldm-modal" role="dialog" aria-modal="true" tabindex="-1">
        <div class="ldm-header">
          <div class="ldm-header-left">
            <span class="ldm-tag-badge" id="ldm-header-tag" style="display:none;"></span>
            <h2 class="ldm-header-title" id="ldm-header-title">加载中...</h2>
          </div>
          <div class="ldm-header-actions">
            <button type="button" class="ldm-btn" id="ldm-prev-btn" title="上一贴 (键盘 ←)">← 上一贴</button>
            <button type="button" class="ldm-btn" id="ldm-next-btn" title="下一贴 (键盘 →)">下一贴 →</button>
            <button type="button" class="ldm-btn ldm-btn-soft" id="ldm-reply-topic-btn" title="回复主贴">💬 回复</button>
            <a class="ldm-btn ldm-btn-primary" id="ldm-open-tab" href="#" target="_blank" rel="noopener noreferrer" title="在新标签页打开原帖">新标签页打开 ↗</a>
            <button type="button" class="ldm-btn ldm-btn-close" id="ldm-close-btn" title="关闭 (Esc)">✕</button>
          </div>
        </div>
        <div id="ldm-body"></div>
        <button type="button" id="ldm-back-top" title="回到顶部">↑</button>
        <div id="ldm-toast" role="status" aria-live="polite"></div>
      </div>
    `;
 
    lightboxEl = document.createElement('div');
    lightboxEl.id = 'ldm-lightbox';
    lightboxEl.innerHTML = `
      <img id="ldm-lightbox-img" src="" alt="图片预览" />
      <div class="ldm-lightbox-bar">
        <a id="ldm-lightbox-link" class="ldm-lightbox-link" href="#" target="_blank" rel="noopener noreferrer">在新标签页查看原图 ↗</a>
      </div>
    `;
 
    document.body.appendChild(overlayEl);
    document.body.appendChild(lightboxEl);
 
    headerTagEl = overlayEl.querySelector('#ldm-header-tag');
    headerTitleEl = overlayEl.querySelector('#ldm-header-title');
    prevBtnEl = overlayEl.querySelector('#ldm-prev-btn');
    nextBtnEl = overlayEl.querySelector('#ldm-next-btn');
    replyTopicBtnEl = overlayEl.querySelector('#ldm-reply-topic-btn');
    openTabLinkEl = overlayEl.querySelector('#ldm-open-tab');
    bodyEl = overlayEl.querySelector('#ldm-body');
    backTopBtnEl = overlayEl.querySelector('#ldm-back-top');
    toastEl = overlayEl.querySelector('#ldm-toast');
    lightboxImgEl = lightboxEl.querySelector('#ldm-lightbox-img');
    lightboxLinkEl = lightboxEl.querySelector('#ldm-lightbox-link');
 
    const stopModalEventLeak = (e) => {
      e.stopPropagation();
    };
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((evt) => {
      overlayEl.addEventListener(evt, stopModalEventLeak);
      lightboxEl.addEventListener(evt, stopModalEventLeak);
    });
 
    overlayEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === overlayEl) closeModal();
    });
 
    overlayEl.querySelector('#ldm-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });
    prevBtnEl.addEventListener('click', () => navigateAdjacent(-1));
    nextBtnEl.addEventListener('click', () => navigateAdjacent(1));
    replyTopicBtnEl.addEventListener('click', () => {
      openReplyComposer({ scopeKey: 'topic', postNumber: null, username: state.opPost?.username || '楼主' });
    });
 
    bodyEl.addEventListener('scroll', () => {
      backTopBtnEl.classList.toggle('ldm-show', bodyEl.scrollTop > 360);
      if (!isProgrammaticScroll) {
        scheduleSaveReadPosition();
        maybeTriggerInfiniteScroll();
      }
    });
    const markUserScrolled = () => {
      state.userHasScrolled = true;
      state.pendingRestoreAnchor = null;
    };
    bodyEl.addEventListener('wheel', markUserScrolled, { passive: true });
    bodyEl.addEventListener('touchstart', markUserScrolled, { passive: true });
    bodyEl.addEventListener('pointerdown', markUserScrolled, { passive: true });
    backTopBtnEl.addEventListener('click', () => {
      markUserScrolled();
      bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
    });
 
    bodyEl.addEventListener('click', handleBodyClick);
    bodyEl.addEventListener('input', (e) => {
      if (e.target.id === 'ldm-reply-textarea') {
        state.replyDraft = e.target.value;
        if (state.replyError) {
          state.replyError = '';
          const errEl = bodyEl.querySelector('#ldm-reply-error');
          if (errEl) errEl.textContent = '';
        }
      }
    });
    bodyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'ldm-reply-textarea') {
        e.preventDefault();
        handleSubmitReply();
      }
    });
 
    lightboxEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === lightboxEl || e.target === lightboxImgEl) {
        closeLightbox();
      }
    });
  }
 
  function openLightbox(displaySrc, originSrc) {
    const targetSrc = originSrc || displaySrc;
    lightboxImgEl.onerror = () => {
      if (lightboxImgEl.src !== displaySrc) {
        lightboxImgEl.src = displaySrc;
      }
    };
    lightboxImgEl.src = targetSrc;
    lightboxLinkEl.href = targetSrc;
    lightboxEl.classList.add('ldm-open');
  }
 
  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('ldm-open');
    lightboxImgEl.src = '';
  }
 
  // ==================== 渲染模块 ====================
  function isTopicLocked() {
    return Boolean(state.topic?.closed || state.topic?.archived);
  }
 
  function renderReplyComposer(isTopicBox = false) {
    if (!state.replyTarget) return '';
    const t = state.replyTarget;
    const title = t.postNumber
      ? `回复 #${t.postNumber} @${escapeHtml(t.username || '')}`
      : `回复主贴（@${escapeHtml(t.username || '楼主')}）`;
    return `
      <div class="ldm-reply-box ${isTopicBox ? 'ldm-reply-box-topic' : ''}" id="ldm-reply-box">
        <div class="ldm-reply-box-head">
          <span>💬 ${title}</span>
          <button type="button" class="ldm-btn ldm-btn-sm" data-action="close-reply" ${state.replySubmitting ? 'disabled' : ''}>取消</button>
        </div>
        <textarea
          id="ldm-reply-textarea"
          class="ldm-reply-textarea"
          placeholder="输入回复内容（支持 Markdown）..."
          ${state.replySubmitting ? 'disabled' : ''}
        >${escapeHtml(state.replyDraft)}</textarea>
        ${state.replyError ? `<div class="ldm-reply-error" id="ldm-reply-error">${escapeHtml(state.replyError)}</div>` : '<div class="ldm-reply-error" id="ldm-reply-error"></div>'}
        <div class="ldm-reply-box-foot">
          <span class="ldm-reply-hint">支持 Markdown · 按 Ctrl/Cmd + Enter 快捷发送</span>
          <div class="ldm-reply-actions">
            <button type="button" class="ldm-btn ldm-btn-sm" data-action="close-reply" ${state.replySubmitting ? 'disabled' : ''}>取消</button>
            <button type="button" class="ldm-btn ldm-btn-sm ldm-btn-primary" data-action="submit-reply" ${state.replySubmitting ? 'disabled' : ''}>
              ${state.replySubmitting ? '发送中...' : '发送回复'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
 
  function renderTreeNode(node, depth = 0, options = {}) {
    const { isSummary = false, parentUsername = '', scopePrefix = 'main' } = options;
 
    // 轻量系统动作楼层（如关帖、置顶、修改分类等 post_type === 3）
    if (Number(node.post_type) === 3 && !node.cooked && node.children.length === 0) {
      const actionLabel = escapeHtml(node.action_code || '系统操作');
      return `
        <div class="ldm-small-action" data-pnum="${node.post_number}">
          <span>⚙️ <strong>${escapeHtml(node.username || '')}</strong> · ${actionLabel} · ${escapeHtml(formatTimeAgo(node.created_at))}</span>
          <span class="ldm-floor-tag">#${node.post_number}</span>
        </div>
      `;
    }
 
    const opUsername = state.opPost?.username || state.topic?.details?.created_by?.username || '';
    const isOp = Boolean(opUsername && node.username === opUsername);
    const collapseKey = `${scopePrefix}:${node.post_number}`;
    const isCollapsed = state.collapsedKeys.has(collapseKey);
 
    const avatar = resolveAvatar(node.avatar_template, 64);
    const displayName = escapeHtml(node.name || node.username || 'L站用户');
    const username = escapeHtml(node.username || '');
    const userUrl = node.username ? `https://linux.do/u/${encodeURIComponent(node.username)}` : '';
    const timeStr = escapeHtml(formatTimeAgo(node.created_at));
    const likes = getLikeCount(node);
    const replyCount = Number(node.reply_count || 0);
 
    const descendantCount = countDescendants(node);
    const subEntry = !node._isPlaceholder && node.id ? subReplyCache.get(`${state.tid}:${node.id}`) : null;
 
    const summarySubExpanded = isSummary && depth === 0
      ? state.expandedSummarySubIds.has(String(node.id))
      : true;
 
    const loadedDirectCount = node.children.length;
    const hasUnloadedSubs = !node._isPlaceholder && !subEntry?.loaded && replyCount > loadedDirectCount;
    const remainingCount = Math.max(0, replyCount - loadedDirectCount);
 
    let floorBadge = `<span class="ldm-floor-tag">#${node.post_number}</span>`;
    if (node._isCrossParent) {
      floorBadge = `<span class="ldm-badge ldm-badge-cross">跨页原楼 #${node.post_number}</span>`;
    } else if (node._fromSubApi) {
      floorBadge = `<span class="ldm-badge ldm-badge-sub">#${node.post_number}</span>`;
    }
 
    const isDeepFlattened = depth >= MAX_INDENT_DEPTH;
    const replyToHint = isDeepFlattened && parentUsername
      ? `<div class="ldm-reply-to-hint">↳ 回复 <strong>@${escapeHtml(parentUsername)}</strong></div>`
      : '';
 
    // 精选热门区根节点若回复了其他楼层，展示轻量上下文提示（支持一键拉取原楼预览）
    let summaryReplyHint = '';
    if (isSummary && depth === 0 && Number(node.reply_to_post_number) > 1) {
      const targetNum = Number(node.reply_to_post_number);
      const targetUser = node.reply_to_user?.username ? `@${escapeHtml(node.reply_to_user.username)}` : '';
      summaryReplyHint = `
        <div class="ldm-reply-to-hint">
          <span>↳ 回复 #${targetNum} ${targetUser}</span>
        </div>
      `;
    }
 
    // 「── 共有 N 条回复 ▾」展开条
    let replyCountBarHtml = '';
    if (isSummary && depth === 0 && replyCount > 0) {
      replyCountBarHtml = `
        <button type="button" class="ldm-reply-count-bar" data-action="toggle-summary-sub" data-postid="${escapeHtml(node.id)}">
          <span class="ldm-gang"></span>
          <span>${summarySubExpanded ? `收起回复 (共 ${replyCount} 条) ▴` : `共有 ${replyCount} 条回复 ▾`}</span>
        </button>
      `;
    } else if (hasUnloadedSubs) {
      const label = loadedDirectCount > 0
        ? `还有 ${remainingCount} 条跨页回复，展开全部 ${replyCount} 条 ▾`
        : `共有 ${replyCount} 条回复，点击展开 ▾`;
      replyCountBarHtml = `
        <button type="button" class="ldm-reply-count-bar" data-action="expand-sub" data-postid="${escapeHtml(node.id)}">
          <span class="ldm-gang"></span>
          <span>${label}</span>
        </button>
      `;
    }
 
    // 节点主体内容（跨页未加载原楼显示一键加载提示；真实节点渲染原生 cooked HTML）
    let bodyHtml = '';
    if (node._isPlaceholder) {
      bodyHtml = `
        <div class="ldm-submeta">
          <span>该回复引用的 <strong>#${node.post_number}</strong> 楼位于其他页</span>
          <button type="button" class="ldm-inline-link-btn" data-action="load-cross-parent" data-pnum="${node.post_number}">
            点击加载 #${node.post_number} 原楼内容
          </button>
        </div>
      `;
    } else {
      bodyHtml = `<div class="cooked ldm-cooked">${sanitizeCookedHtml(node.cooked || '')}</div>`;
    }
 
    // 子节点递归渲染
    let childrenHtml = '';
    if (!isCollapsed && summarySubExpanded && node.children.length > 0) {
      const renderedChildren = node.children
        .map((child) => renderTreeNode(child, depth + 1, {
          isSummary,
          parentUsername: node.username || '',
          scopePrefix,
        }))
        .join('');
 
      childrenHtml = isSummary && depth === 0
        ? `<div class="ldm-tree-children ldm-tree-children-topwrap">${renderedChildren}</div>`
        : `<div class="ldm-tree-children">${renderedChildren}</div>`;
    }
 
    const deepOverflowChildren = !isCollapsed && isDeepFlattened && node.children.length > 0;
    const inlineChildrenHtml = deepOverflowChildren ? '' : childrenHtml;
    const siblingChildrenHtml = deepOverflowChildren ? childrenHtml : '';
 
    const nodeClasses = [
      'ldm-tree-node',
      depth === 0 ? 'ldm-level-0' : '',
      node._isCrossParent ? 'ldm-node-cross' : '',
    ].filter(Boolean).join(' ');
 
    const replyScopeKey = `${scopePrefix}:${node.post_number}`;
    const canReplyNode = !node._isPlaceholder && !isTopicLocked();
    const isReplyingHere = Boolean(state.replyTarget && state.replyTarget.scopeKey === replyScopeKey);
 
    return `
      <div class="${nodeClasses}" data-pnum="${node.post_number}" data-depth="${depth}">
        <div class="ldm-tree-author ${isCollapsed ? 'ldm-is-collapsed' : ''}" ${isCollapsed ? `data-action="toggle-collapse" data-ckey="${escapeHtml(collapseKey)}" title="点击展开"` : ''}>
          <div class="ldm-tree-author-left">
            ${isCollapsed ? `<button type="button" class="ldm-collapse-trigger" data-action="toggle-collapse" data-ckey="${escapeHtml(collapseKey)}" title="展开评论">+</button>` : ''}
            ${avatar ? `<img class="ldm-tree-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}
            ${userUrl ? `<a class="ldm-author-name" href="${escapeHtml(userUrl)}" target="_blank" rel="noopener noreferrer">${displayName}</a>` : `<span class="ldm-author-name">${displayName}</span>`}
            ${node.name && node.username && node.name !== node.username ? `<span class="ldm-user-handle">@${username}</span>` : ''}
            ${isOp ? '<span class="ldm-badge ldm-badge-op">楼主</span>' : ''}
            ${node.staff || node.admin || node.moderator ? '<span class="ldm-badge ldm-badge-staff">管理</span>' : ''}
            ${node.user_title ? `<span class="ldm-badge ldm-badge-title">${escapeHtml(node.user_title)}</span>` : ''}
            ${timeStr ? `<span class="ldm-tree-time">${timeStr}</span>` : ''}
            ${isCollapsed ? `<span class="ldm-collapsed-summary">已折叠${descendantCount > 0 ? ` · 含 ${descendantCount} 条子回复` : ''}</span>` : ''}
          </div>
          <div class="ldm-tree-author-right">
            ${canReplyNode ? `<button type="button" class="ldm-reply-trigger" data-action="open-reply" data-scopekey="${escapeHtml(replyScopeKey)}" data-pnum="${node.post_number}" data-username="${username}" title="回复第 ${node.post_number} 楼">回复</button>` : ''}
            ${likes > 0 ? `<span class="ldm-like-pill">❤ ${likes}</span>` : ''}
            ${floorBadge}
          </div>
        </div>
        ${!isCollapsed ? `
          <div class="ldm-tree-content-wrap">
            <div class="ldm-expand-line" data-action="toggle-collapse" data-ckey="${escapeHtml(collapseKey)}" title="点击折叠该楼层及子回复"></div>
            <div class="ldm-tree-right">
              <div class="ldm-tree-body-inner">
                ${replyToHint}
                ${summaryReplyHint}
                ${bodyHtml}
                ${isReplyingHere ? renderReplyComposer(false) : ''}
                ${replyCountBarHtml}
              </div>
              ${inlineChildrenHtml}
            </div>
          </div>
        ` : ''}
      </div>
      ${siblingChildrenHtml}
    `;
  }
 
  function renderFlatPostItem(post) {
    const opUsername = state.opPost?.username || '';
    const isOp = Boolean(opUsername && post.username === opUsername);
    const avatar = resolveAvatar(post.avatar_template, 64);
    const displayName = escapeHtml(post.name || post.username || 'L站用户');
    const username = escapeHtml(post.username || '');
    const userUrl = post.username ? `https://linux.do/u/${encodeURIComponent(post.username)}` : '';
    const timeStr = escapeHtml(formatTimeAgo(post.created_at));
    const likes = getLikeCount(post);
    const replyToNum = Number(post.reply_to_post_number || 0);
    const replyScopeKey = `flat:${post.post_number}`;
    const isReplyingHere = Boolean(state.replyTarget && state.replyTarget.scopeKey === replyScopeKey);
 
    return `
      <div class="ldm-tree-node ldm-level-0" data-pnum="${post.post_number}">
        <div class="ldm-tree-author">
          <div class="ldm-tree-author-left">
            ${avatar ? `<img class="ldm-tree-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}
            ${userUrl ? `<a class="ldm-author-name" href="${escapeHtml(userUrl)}" target="_blank" rel="noopener noreferrer">${displayName}</a>` : `<span class="ldm-author-name">${displayName}</span>`}
            ${isOp ? '<span class="ldm-badge ldm-badge-op">楼主</span>' : ''}
            ${timeStr ? `<span class="ldm-tree-time">${timeStr}</span>` : ''}
          </div>
          <div class="ldm-tree-author-right">
            ${!isTopicLocked() ? `<button type="button" class="ldm-reply-trigger" data-action="open-reply" data-scopekey="${escapeHtml(replyScopeKey)}" data-pnum="${post.post_number}" data-username="${username}" title="回复第 ${post.post_number} 楼">回复</button>` : ''}
            ${likes > 0 ? `<span class="ldm-like-pill">❤ ${likes}</span>` : ''}
            <span class="ldm-floor-tag">#${post.post_number}</span>
          </div>
        </div>
        <div class="ldm-tree-content-wrap">
          <div class="ldm-expand-line" style="cursor:default;pointer-events:none;opacity:0.38;"></div>
          <div class="ldm-tree-right">
            <div class="ldm-tree-body-inner">
              ${replyToNum > 1 ? `<div class="ldm-reply-to-hint">↳ 回复 #${replyToNum} ${post.reply_to_user?.username ? `@${escapeHtml(post.reply_to_user.username)}` : ''}</div>` : ''}
              <div class="cooked ldm-cooked">${sanitizeCookedHtml(post.cooked || '')}</div>
              ${isReplyingHere ? renderReplyComposer(false) : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }
 
  function renderPrependPrevBar(range) {
    if (state.loading || range.min <= 1) return '';
    const prevPage = range.min - 1;
    return `
      <div class="ldm-prepend-bar" id="ldm-prepend-bar">
        <button type="button" class="ldm-prepend-btn" data-action="prepend-prev-page" ${state.prependLoading ? 'disabled' : ''}>
          ${state.prependLoading ? `正在加载第 ${prevPage} 页更早评论...` : `↑ 加载更早的第 ${prevPage} 页评论（前面还有 ${prevPage} 页）`}
        </button>
        <button type="button" class="ldm-btn ldm-btn-sm" data-action="goto-first-page" ${state.prependLoading ? 'disabled' : ''}>回到第 1 页</button>
      </div>
    `;
  }
 
  function renderScrollFooter(range, totalPages, flatPostsCount) {
    if (state.loading || flatPostsCount === 0) return '';
 
    if (range.max >= totalPages) {
      if (range.min <= 1) {
        return `
          <div class="ldm-scroll-footer ldm-scroll-end" id="ldm-scroll-footer">
            <span>— 已加载全部 ${state.activeStream.length} 条评论 —</span>
          </div>
        `;
      }
      return `
        <div class="ldm-scroll-footer ldm-scroll-end" id="ldm-scroll-footer">
          <span>— 已到达底部（前面还有 ${range.min - 1} 页更早评论，可在顶部加载）—</span>
        </div>
      `;
    }
 
    const nextPage = range.max + 1;
    if (state.batchLoading) {
      return `
        <div class="ldm-scroll-footer ldm-scroll-loading" id="ldm-scroll-footer">
          <span class="ldm-spinner-sm"></span>
          <span>正在分批预加载评论（已加载 ${state.loadedPostsByPage.size} / ${totalPages} 页）...</span>
        </div>
      `;
    }
    if (state.appendLoading) {
      return `
        <div class="ldm-scroll-footer ldm-scroll-loading" id="ldm-scroll-footer">
          <span class="ldm-spinner-sm"></span>
          <span>正在加载第 ${nextPage} / ${totalPages} 页评论...</span>
        </div>
      `;
    }
    if (state.autoLoadError) {
      return `
        <div class="ldm-scroll-footer ldm-scroll-error" id="ldm-scroll-footer">
          <span>⚠️ ${escapeHtml(state.autoLoadError)}</span>
          <button type="button" class="ldm-btn ldm-btn-sm ldm-btn-soft" data-action="append-next-page">继续加载第 ${nextPage} 页</button>
        </div>
      `;
    }
    return `
      <div class="ldm-scroll-footer" id="ldm-scroll-footer">
        <span>继续下滑自动加载第 ${nextPage} / ${totalPages} 页</span>
        <button type="button" class="ldm-inline-link-btn" data-action="append-next-page">立即加载</button>
      </div>
    `;
  }
 
  function renderLoading(message = '正在加载帖子与评论...') {
    bodyEl.innerHTML = `
      <div class="ldm-state-box">
        <div class="ldm-spinner"></div>
        <div>${escapeHtml(message)}</div>
      </div>
    `;
  }
 
  function renderError(msg, url) {
    bodyEl.innerHTML = `
      <div class="ldm-card">
        <div class="ldm-state-box">
          <div style="font-size:15px;font-weight:600;color:var(--primary,#111827);">${escapeHtml(msg)}</div>
          <div style="display:flex;gap:10px;margin-top:6px;">
            <button type="button" class="ldm-btn" data-action="refresh">重试</button>
            <a class="ldm-btn ldm-btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开原帖 ↗</a>
          </div>
        </div>
      </div>
    `;
  }
 
  function renderModalContent(preserveScroll = false) {
    const topic = state.topic;
    const op = state.opPost;
    if (!topic || !op) return;
 
    const prevScrollTop = preserveScroll ? bodyEl.scrollTop : 0;
    const prevAnchor = preserveScroll && prevScrollTop > 40 ? captureViewportAnchor() : null;
    // 若用户正在回复框输入，记住光标位置，防止后台预加载重绘时打断输入
    const activeTextarea = document.activeElement?.id === 'ldm-reply-textarea' ? document.activeElement : null;
    const savedFocus = activeTextarea
      ? { start: activeTextarea.selectionStart, end: activeTextarea.selectionEnd }
      : null;
 
    const topicUrl = `https://linux.do/t/${encodeURIComponent(topic.slug || 'topic')}/${topic.id}`;
 
    headerTitleEl.textContent = topic.title || state.initialTitle || `话题 #${topic.id}`;
    const firstTag = Array.isArray(topic.tags) && topic.tags.length ? topic.tags[0] : '';
    if (firstTag) {
      headerTagEl.textContent = `#${firstTag}`;
      headerTagEl.style.display = 'inline-block';
    } else {
      headerTagEl.style.display = 'none';
    }
    openTabLinkEl.href = topicUrl;
    if (replyTopicBtnEl) {
      const locked = isTopicLocked();
      replyTopicBtnEl.disabled = locked;
      replyTopicBtnEl.textContent = locked ? '🔒 已关闭' : '💬 回复';
      replyTopicBtnEl.title = locked ? '该话题已关闭或归档，无法回复' : '回复主贴';
    }
    updateNavButtons();
 
    const opAvatar = resolveAvatar(op.avatar_template, 96);
    const opDisplayName = escapeHtml(op.name || op.username || '楼主');
    const opUserUrl = op.username ? `https://linux.do/u/${encodeURIComponent(op.username)}` : '';
    const opLikes = getLikeCount(op);
    const totalReplies = Math.max(0, Number(topic.posts_count || 1) - 1);
 
    const tagsHtml = Array.isArray(topic.tags) && topic.tags.length
      ? `<div class="ldm-topic-tags">${topic.tags.map((t) => `<a class="ldm-topic-tag" href="https://linux.do/tag/${encodeURIComponent(t)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(t)}</a>`).join('')}</div>`
      : '';
 
    const mainPostHtml = `
      <article class="ldm-card" id="ldm-op-article" data-pnum="1">
        <h1 class="ldm-post-title">${escapeHtml(topic.title || '')}</h1>
        ${tagsHtml}
        <div class="ldm-author-row">
          <div class="ldm-author-info">
            ${opAvatar ? `<img class="ldm-avatar" src="${escapeHtml(opAvatar)}" alt="" />` : ''}
            <div class="ldm-author-meta">
              <div class="ldm-author-name-line">
                ${opUserUrl ? `<a class="ldm-author-name" href="${escapeHtml(opUserUrl)}" target="_blank" rel="noopener noreferrer">${opDisplayName}</a>` : `<span class="ldm-author-name">${opDisplayName}</span>`}
                ${op.name && op.username && op.name !== op.username ? `<span class="ldm-user-handle">@${escapeHtml(op.username)}</span>` : ''}
                <span class="ldm-badge ldm-badge-op">楼主</span>
                ${op.user_title ? `<span class="ldm-badge ldm-badge-title">${escapeHtml(op.user_title)}</span>` : ''}
              </div>
              <div class="ldm-submeta">
                <span>${escapeHtml(formatTimeAgo(op.created_at))}</span>
                ${opLikes > 0 ? `<span>· ❤ ${opLikes} 赞</span>` : ''}
              </div>
            </div>
          </div>
          <div class="ldm-post-stats">
            <span>浏览 ${formatNumber(topic.views)}</span>
            <span>点赞 ${formatNumber(topic.like_count)}</span>
            <span>回复 ${formatNumber(totalReplies)}</span>
          </div>
        </div>
        <div class="ldm-op-body-wrap" id="ldm-op-body-wrap">
          <div class="cooked ldm-cooked ldm-cooked-main">
            ${sanitizeCookedHtml(op.cooked || '')}
          </div>
          <div class="ldm-op-fade"></div>
        </div>
        <div class="ldm-op-toggle-bar" id="ldm-op-toggle-bar">
          <button type="button" class="ldm-op-toggle-btn" id="ldm-op-toggle-btn" data-action="toggle-op-expand">
            展开全部正文 ▾
          </button>
        </div>
      </article>
    `;
 
    const flatPosts = getLoadedPostsFlat();
    const range = getLoadedPageRange();
    const totalPages = state.totalPages;
    const unloadedAfterMax = Math.max(0, totalPages - range.max);
 
    let mergeBtnHtml = '';
    if (state.tab === 'all' && state.viewMode === 'tree' && totalPages > 1 && state.loadedPostsByPage.size < totalPages) {
      if (state.batchLoading) {
        mergeBtnHtml = `<button type="button" class="ldm-btn ldm-btn-sm" data-action="cancel-batch">停止合并 (${state.batchDone}/${state.batchTotal})</button>`;
      } else {
        const remainingAll = totalPages - state.loadedPostsByPage.size;
        const mergeLabel = remainingAll <= AUTO_ALL_THRESHOLD
          ? `合并全部 ${totalPages} 页楼中楼`
          : `合并下 ${Math.min(BATCH_MERGE_SIZE, unloadedAfterMax || remainingAll)} 页楼中楼`;
        mergeBtnHtml = `<button type="button" class="ldm-btn ldm-btn-sm ldm-btn-soft" data-action="batch-merge" title="合并多页评论到同一棵楼中楼树">${mergeLabel}</button>`;
      }
    }
 
    const toolbarHtml = `
      <div class="ldm-toolbar" id="ldm-comments-anchor">
        <div class="ldm-tabs">
          <button type="button" class="ldm-tab ${!state.onlyAuthor && state.tab === 'all' ? 'ldm-active' : ''}" data-action="tab-all">
            全部评论 (${totalReplies})
          </button>
          ${totalReplies >= 5 ? `
            <button type="button" class="ldm-tab ${!state.onlyAuthor && state.tab === 'summary' ? 'ldm-active' : ''}" data-action="tab-summary">
              🔥 热门精选
            </button>
          ` : ''}
          <button type="button" class="ldm-tab ${state.onlyAuthor ? 'ldm-active' : ''}" data-action="toggle-author">
            只看楼主
          </button>
        </div>
        <div class="ldm-toolbar-right">
          ${!isTopicLocked() ? `
            <button type="button" class="ldm-btn ldm-btn-sm ldm-btn-primary" data-action="open-reply" data-scopekey="topic" data-pnum="" data-username="${escapeHtml(op.username || '楼主')}">💬 回复主贴</button>
          ` : ''}
          ${state.tab === 'all' ? `
            <div class="ldm-seg-group" title="切换评论展示样式">
              <button type="button" class="ldm-seg-btn ${state.viewMode === 'tree' ? 'ldm-seg-active' : ''}" data-action="mode-tree">楼中楼</button>
              <button type="button" class="ldm-seg-btn ${state.viewMode === 'flat' ? 'ldm-seg-active' : ''}" data-action="mode-flat">平铺</button>
            </div>
          ` : ''}
          ${mergeBtnHtml}
          ${state.viewMode === 'tree' && state.collapsedKeys.size > 0 ? `
            <button type="button" class="ldm-btn ldm-btn-sm" data-action="expand-all-nodes">全部展开</button>
          ` : ''}
          <button type="button" class="ldm-btn ldm-btn-sm ${state.defaultCollapseOp ? 'ldm-btn-soft' : ''}" data-action="toggle-default-op" title="切换打开帖子时主贴长文的默认状态（自动记住设置）">
            ${state.defaultCollapseOp ? '正文: 默认收缩' : '正文: 默认展开'}
          </button>
          <button type="button" class="ldm-btn ldm-btn-sm" data-action="refresh" title="强制重新拉取最新正文与评论">${state.revalidating ? '同步中...' : '刷新'}</button>
        </div>
      </div>
    `;
 
    let liveBannerHtml = '';
    if (state.pendingNewCount > 0) {
      liveBannerHtml = `
        <div class="ldm-new-replies-banner" data-action="goto-latest-new" role="button" tabindex="0">
          <span>🔔 收到 ${state.pendingNewCount} 条新回复${state.pendingLatestPostNum ? `（最新 #${state.pendingLatestPostNum} 楼）` : ''}</span>
          <span>点击跳转到最新一页查看 →</span>
        </div>
      `;
    }
 
    let batchBarHtml = '';
    if (state.batchLoading) {
      const pct = state.batchTotal > 0 ? Math.round((state.batchDone / state.batchTotal) * 100) : 0;
      const label = state.batchLabel || '正在分批合并加载评论';
      batchBarHtml = `
        <div class="ldm-batch-bar">
          <span>${escapeHtml(label)}（${state.batchDone} / ${state.batchTotal} 页，已节流防限频）...</span>
          <div class="ldm-batch-progress"><div class="ldm-batch-progress-fill" style="width:${pct}%"></div></div>
          <button type="button" class="ldm-btn ldm-btn-sm" data-action="cancel-batch">停止</button>
        </div>
      `;
    } else if (state.batchNotice) {
      batchBarHtml = `
        <div class="ldm-batch-bar">
          <span>⚠️ ${escapeHtml(state.batchNotice)}</span>
        </div>
      `;
    }
 
    let commentsCardHtml = '';
    if (state.tab === 'summary' && !state.onlyAuthor) {
      let summaryBody = '';
      if (state.loading && !state.summaryPosts) {
        summaryBody = `<div class="ldm-state-box" style="padding:36px 20px;"><div class="ldm-spinner"></div><div>正在加载热门精选回复...</div></div>`;
      } else if (!state.summaryPosts || state.summaryPosts.length === 0) {
        summaryBody = `<div class="ldm-state-box" style="padding:36px 20px;"><div>该话题暂无热门精选回复</div></div>`;
      } else {
        summaryBody = state.summaryPosts
          .map((p) => renderTreeNode(buildSubTreeForSummary(p, state.tid), 0, { isSummary: true, scopePrefix: 'summary' }))
          .join('');
      }
      commentsCardHtml = `
        <section class="ldm-card ldm-card-comments">
          <div class="ldm-section-header">
            <h3 class="ldm-section-title">🔥 热门精选回复 (${state.summaryPosts ? state.summaryPosts.length : 0})</h3>
            <span class="ldm-submeta">基于 Discourse 话题摘要筛选 · 点击左侧竖线可折叠</span>
          </div>
          ${summaryBody}
        </section>
      `;
    } else {
      let pageDesc = '';
      if (totalPages > 1) {
        if (state.loadedPostsByPage.size >= totalPages) {
          pageDesc = `已加载全部 ${totalPages} 页`;
        } else if (state.loadedPostsByPage.size > 1) {
          pageDesc = `已加载第 ${range.min}~${range.max} 页 / 共 ${totalPages} 页`;
        } else {
          pageDesc = `当前第 ${range.min} / ${totalPages} 页`;
        }
      }
 
      const sectionHeading = state.onlyAuthor
        ? `只看楼主 (${state.activeStream.length})`
        : `${state.viewMode === 'tree' ? '全部评论 · 楼中楼' : '全部评论 · 平铺'} (${state.activeStream.length})`;
 
      let listContent = '';
      if (state.loading && flatPosts.length === 0) {
        listContent = `
          <div class="ldm-state-box" style="padding:36px 20px;">
            <div class="ldm-spinner"></div>
            <div>正在加载第 ${state.page} 页评论...</div>
          </div>
        `;
      } else if (flatPosts.length === 0) {
        listContent = `
          <div class="ldm-state-box" style="padding:36px 20px;">
            <div>${state.onlyAuthor ? '楼主暂未在本帖发表其他回复' : '暂无评论'}</div>
          </div>
        `;
      } else if (state.viewMode === 'tree') {
        const roots = buildCommentTree(flatPosts, state.tid);
        listContent = roots.map((r) => renderTreeNode(r, 0, { isSummary: false, scopePrefix: 'main' })).join('');
      } else {
        listContent = flatPosts.map(renderFlatPostItem).join('');
      }
 
      const prependPrevHtml = flatPosts.length > 0 ? renderPrependPrevBar(range) : '';
      const scrollFooterHtml = renderScrollFooter(range, totalPages, flatPosts.length);
 
      commentsCardHtml = `
        <section class="ldm-card ldm-card-comments">
          <div class="ldm-section-header">
            <h3 class="ldm-section-title">💬 ${escapeHtml(sectionHeading)}</h3>
            <span class="ldm-submeta">
              ${pageDesc ? `<span>${escapeHtml(pageDesc)}</span>` : ''}
              ${state.viewMode === 'tree' ? '<span>· 点击左侧竖线可折叠子树</span>' : ''}
            </span>
          </div>
          ${prependPrevHtml}
          ${listContent}
          ${scrollFooterHtml}
        </section>
      `;
    }
 
    const topicReplyBoxHtml = state.replyTarget?.scopeKey === 'topic' ? renderReplyComposer(true) : '';
    bodyEl.innerHTML = mainPostHtml + topicReplyBoxHtml + toolbarHtml + liveBannerHtml + batchBarHtml + commentsCardHtml;
    syncOpCollapseState();
 
    // 恢复回复框焦点与光标位置（避免后台分页预加载打断输入）
    if (savedFocus) {
      const nextTa = bodyEl.querySelector('#ldm-reply-textarea');
      if (nextTa) {
        nextTa.focus({ preventScroll: true });
        try {
          nextTa.setSelectionRange(savedFocus.start, savedFocus.end);
        } catch {
          // ignore
        }
      }
    }
 
    // 当主贴内懒加载图片撑开高度后，重新检测是否需要显示折叠/收起开关，并在恢复定位期间保持锚点稳定
    const opWrap = bodyEl.querySelector('#ldm-op-body-wrap');
    const renderSeq = state.requestSeq;
    if (opWrap) {
      opWrap.querySelectorAll('img').forEach((imgEl) => {
        if (!imgEl.complete) {
          imgEl.addEventListener('load', () => {
            if (renderSeq !== state.requestSeq || !state.isOpen) return;
            syncOpCollapseState(true);
            if (state.pendingRestoreAnchor && !state.userHasScrolled) {
              alignToAnchor(state.pendingRestoreAnchor, { allowNearest: true });
            }
          }, { once: true });
        }
      });
    }
 
    if (preserveScroll) {
      if (prevAnchor && prevAnchor.postNumber > 1) {
        const res = alignToAnchor(prevAnchor, { allowNearest: false });
        if (!res.ok) setBodyScrollTopProgrammatic(prevScrollTop);
      } else {
        setBodyScrollTopProgrammatic(prevScrollTop);
      }
    }
  }
 
  function syncOpCollapseState(compensateScroll = false) {
    const opWrap = bodyEl?.querySelector('#ldm-op-body-wrap');
    const toggleBar = bodyEl?.querySelector('#ldm-op-toggle-bar');
    const toggleBtn = bodyEl?.querySelector('#ldm-op-toggle-btn');
    if (!opWrap || !toggleBar || !toggleBtn) return;
 
    const bodyRect = bodyEl.getBoundingClientRect();
    const prevWrapRect = opWrap.getBoundingClientRect();
    const isOpAboveViewport = compensateScroll && prevWrapRect.top < bodyRect.top;
    const prevVisibleHeight = prevWrapRect.height;
 
    // 先临时解除高度限制测量真实内容高度
    const wasCollapsed = opWrap.classList.contains('ldm-op-collapsed');
    if (wasCollapsed) opWrap.classList.remove('ldm-op-collapsed');
    const fullHeight = opWrap.scrollHeight;
 
    const isLong = fullHeight > OP_COLLAPSE_MAX_HEIGHT + 60;
    if (!isLong) {
      opWrap.classList.remove('ldm-op-collapsed');
      toggleBar.classList.remove('ldm-show');
    } else {
      toggleBar.classList.add('ldm-show');
      if (state.opExpanded) {
        opWrap.classList.remove('ldm-op-collapsed');
        toggleBtn.textContent = '收起正文 ▴';
      } else {
        opWrap.classList.add('ldm-op-collapsed');
        toggleBtn.textContent = '展开全部正文 ▾';
      }
    }
 
    if (isOpAboveViewport) {
      const nextHeight = opWrap.getBoundingClientRect().height;
      const delta = nextHeight - prevVisibleHeight;
      if (Math.abs(delta) >= 2) {
        setBodyScrollTopProgrammatic(bodyEl.scrollTop + delta);
      }
    }
  }
 
  function updateNavButtons() {
    if (!prevBtnEl || !nextBtnEl) return;
    const hasList = state.topicList.length > 1 && state.currentIndex >= 0;
    prevBtnEl.disabled = !hasList || state.currentIndex <= 0;
    nextBtnEl.disabled = !hasList || state.currentIndex >= state.topicList.length - 1;
  }
 
  // ==================== 核心交互逻辑 ====================
  async function openTopicModal(tid, initialTitle = '', options = {}) {
    ldmLog('openTopicModal', { tid, pathname: location.pathname, wasOpen: state.isOpen, options });
    ensureModalDOM();
    // 切换帖子前，立即保存上一个已打开帖子的浏览位置
    if (state.isOpen && state.tid) {
      saveCurrentReadPosition(true);
    }
    markVisited(tid);
 
    state.topicList = collectPageTopicList();
    state.currentIndex = state.topicList.findIndex((item) => item.tid === String(tid));
 
    if (!state.isOpen) {
      state.prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      overlayEl.classList.add('ldm-open');
      state.isOpen = true;
      // 清除原页面焦点并将焦点移入弹窗，避免原页面右上角头像等控件残余焦点被误触
      if (document.activeElement && !overlayEl.contains(document.activeElement)) {
        try {
          document.activeElement.blur?.();
        } catch {
          // ignore
        }
      }
      overlayEl.querySelector('#ldm-modal')?.focus?.({ preventScroll: true });
    }
 
    stopLiveUpdates();
    stopReadTracker(true);
    state.batchCancelToken++;
    state.batchLoading = false;
    state.batchLabel = '';
    state.batchNotice = '';
    state.appendLoading = false;
    state.prependLoading = false;
    state.autoLoadPaused = false;
    state.autoLoadError = '';
    state.revalidating = false;
    state.pendingNewCount = 0;
    state.pendingLatestPostNum = 0;
    state.positionReady = false;
    state.userHasScrolled = false;
    state.pendingRestoreAnchor = null;
    state.openExplicitPostNumber = options.explicitPostNumber ? Number(options.explicitPostNumber) : null;
    state.openIsDirectPostLink = Boolean(options.isDirectPostLink);
    state.tid = String(tid);
    state.initialTitle = initialTitle || state.topicList[state.currentIndex]?.title || `话题 #${tid}`;
    state.topic = null;
    state.opPost = null;
    state.replyStream = [];
    state.activeStream = [];
    state.pageChunks = [];
    state.opExpanded = !state.defaultCollapseOp;
    state.loadedPostsByPage = new Map();
    state.crossParentPosts = new Map();
    state.summaryPosts = null;
    state.collapsedKeys = new Set();
    state.expandedSummarySubIds = new Set();
    state.replyTarget = null;
    state.replyDraft = '';
    state.replySubmitting = false;
    state.replyError = '';
    state.page = 1;
    state.totalPages = 1;
    state.tab = 'all';
    state.onlyAuthor = false;
 
    headerTagEl.style.display = 'none';
    headerTitleEl.textContent = state.initialTitle;
    openTabLinkEl.href = `https://linux.do/t/topic/${tid}`;
    updateNavButtons();
    setBodyScrollTopProgrammatic(0);
 
    await loadTopicInitial(false);
  }
 
  /**
   * 构建分页切片：
   * Discourse 的 /t/{id}.json 通常自带 20 条帖子（1 条 OP + 19 条回复）。
   * 将首屏已随接口返回的回复直接作为第 1 页（零额外请求），剩余回复按每页 PAGE_SIZE（20）条切分。
   */
  function buildPageChunks(streamIds, firstPageCount = 0) {
    const chunks = [];
    if (!Array.isArray(streamIds) || streamIds.length === 0) return chunks;
    const firstLen = firstPageCount > 0 ? Math.min(firstPageCount, streamIds.length) : Math.min(PAGE_SIZE, streamIds.length);
    chunks.push(streamIds.slice(0, firstLen));
    for (let i = firstLen; i < streamIds.length; i += PAGE_SIZE) {
      chunks.push(streamIds.slice(i, i + PAGE_SIZE));
    }
    return chunks;
  }
 
  function getPagePostIds(pageNum) {
    const idx = (Number(pageNum) || 1) - 1;
    if (idx < 0 || idx >= state.pageChunks.length) return [];
    return state.pageChunks[idx];
  }
 
  function findPageByPostId(postId) {
    const target = Number(postId);
    if (!target) return null;
    for (let i = 0; i < state.pageChunks.length; i++) {
      if (state.pageChunks[i].some((id) => Number(id) === target)) {
        return i + 1;
      }
    }
    return null;
  }
 
  function estimatePageForPostNumber(postNumber) {
    const totalReplies = state.replyStream.length;
    if (totalReplies === 0 || state.totalPages <= 1) return 1;
    const pNum = Number(postNumber);
    if (!Number.isFinite(pNum) || pNum <= 1) return 1;
    const highest = Math.max(Number(state.topic?.highest_post_number || 0), totalReplies + 1);
    const ratio = Math.max(0, Math.min(1, (pNum - 2) / Math.max(1, highest - 1)));
    const estIdx = Math.min(totalReplies - 1, Math.floor(ratio * totalReplies));
    const firstLen = state.pageChunks[0]?.length || PAGE_SIZE;
    if (estIdx < firstLen) return 1;
    const page = 2 + Math.floor((estIdx - firstLen) / PAGE_SIZE);
    return Math.max(1, Math.min(state.totalPages, page));
  }
 
  function resolveRestoreTarget({ tid, explicitPostNumber, isDirectPostLink, topicData }) {
    const serverLastRead = Number(topicData?.last_read_post_number || 0);
    const saved = getSavedReadPosition(tid);
 
    // 1. 若用户主动点击了非标题直达楼层链接（例如未读角标、最新回复时间列），优先直达目标楼层
    if (isDirectPostLink && explicitPostNumber && explicitPostNumber > 1) {
      return {
        source: 'link',
        postNumber: explicitPostNumber,
        postId: null,
        anchorOffset: null,
        scrollTop: null,
        page: null,
        loadedPages: null,
        opExpanded: null,
      };
    }
 
    // 2. 有本地保存记录时，优先恢复本地精确位置；若用户在其他标签页/设备读得更远，则同步到更远位置
    if (saved) {
      const savedPostNum = Number(saved.postNumber || 1);
      const savedServerRead = Number(saved.serverLastRead || 0);
      const readFurtherExternally = serverLastRead > Math.max(savedPostNum, savedServerRead);
      if (readFurtherExternally) {
        return {
          source: 'server',
          postNumber: serverLastRead,
          postId: null,
          anchorOffset: null,
          scrollTop: null,
          page: null,
          loadedPages: null,
          opExpanded: null,
        };
      }
      return {
        source: 'local',
        postNumber: savedPostNum,
        postId: saved.postId ? Number(saved.postId) : null,
        anchorOffset: Number.isFinite(saved.anchorOffset) ? saved.anchorOffset : null,
        scrollTop: Number.isFinite(saved.scrollTop) ? saved.scrollTop : 0,
        page: saved.page ? Number(saved.page) : null,
        loadedPages: Array.isArray(saved.loadedPages) ? saved.loadedPages.map(Number).filter((p) => p >= 1) : null,
        opExpanded: typeof saved.opExpanded === 'boolean' ? saved.opExpanded : null,
      };
    }
 
    // 3. 无本地记录时，兜底使用 Discourse 服务端 last_read_post_number 或 URL 携带的楼层号
    const remotePostNum = Math.max(Number(explicitPostNumber || 0), serverLastRead);
    if (remotePostNum > 1) {
      return {
        source: serverLastRead >= Number(explicitPostNumber || 0) ? 'server' : 'link',
        postNumber: remotePostNum,
        postId: null,
        anchorOffset: null,
        scrollTop: null,
        page: null,
        loadedPages: null,
        opExpanded: null,
      };
    }
 
    return null;
  }
 
  function applyTopicMetaOnly(data) {
    const posts = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
    const stream = Array.isArray(data?.post_stream?.stream) ? data.post_stream.stream : [];
    const op = posts.find((p) => Number(p.post_number) === 1) || posts[0] || null;
    if (!op) return null;
 
    const replyStream = stream.filter((id) => Number(id) !== Number(op.id));
    const returnedPostMap = new Map(posts.map((p) => [Number(p.id), p]));
 
    let initialCount = 0;
    const page1Posts = [];
    for (let i = 0; i < replyStream.length && i < PAGE_SIZE; i++) {
      const hit = returnedPostMap.get(Number(replyStream[i]));
      if (!hit) break;
      page1Posts.push(hit);
      initialCount++;
    }
 
    state.topic = data;
    state.opPost = op;
    state.replyStream = replyStream;
    state.activeStream = replyStream;
    state.pageChunks = buildPageChunks(replyStream, initialCount);
    state.totalPages = Math.max(1, state.pageChunks.length);
    return { op, replyStream, initialCount, page1Posts };
  }
 
  function computeRestorePagePlan(tid, target) {
    if (!target || Number(target.postNumber || 1) <= 1 || state.replyStream.length === 0) {
      return { targetPage: 1, pagesToLoad: [1], exactById: true };
    }
 
    let exactPage = null;
    if (target.postId) {
      exactPage = findPageByPostId(target.postId);
    }
    if (!exactPage) {
      const cachedByNum = postByNumberCache.get(`${tid}:${target.postNumber}`);
      if (cachedByNum?.id) {
        exactPage = findPageByPostId(cachedByNum.id);
      }
    }
 
    let targetPage = exactPage;
    if (!targetPage && target.source === 'local' && target.page >= 1 && target.page <= state.totalPages) {
      targetPage = target.page;
    }
    if (!targetPage) {
      targetPage = estimatePageForPostNumber(target.postNumber);
    }
    targetPage = Math.max(1, Math.min(state.totalPages, targetPage));
 
    // 尽量还原相近的合并页结构，同时严格限制冷启动时的网络请求数避免触发 429
    let pagesToLoad = [targetPage];
    if (target.source === 'local' && Array.isArray(target.loadedPages) && target.loadedPages.length > 1) {
      const validSavedPages = target.loadedPages.filter((p) => p >= 1 && p <= state.totalPages);
      if (validSavedPages.includes(targetPage)) {
        const uncachedCount = validSavedPages.filter((p) => p !== 1 && !isPageFullyCached(tid, p)).length;
        // 若目标就在第 1 页，仅在其余页均已命中缓存时才立即合并，否则先秒开第 1 页，剩余页交由后台预加载
        if (targetPage === 1) {
          if (uncachedCount === 0 && validSavedPages.length <= Math.max(AUTO_PRELOAD_PAGES, 6)) {
            pagesToLoad = validSavedPages;
          }
        } else if (uncachedCount <= 2 && validSavedPages.length <= Math.max(AUTO_PRELOAD_PAGES, 6)) {
          pagesToLoad = validSavedPages;
        } else if (state.viewMode === 'tree' && targetPage <= AUTO_PRELOAD_PAGES && validSavedPages.includes(1)) {
          pagesToLoad = [];
          for (let p = 1; p <= targetPage; p++) pagesToLoad.push(p);
        }
      }
    } else if (state.viewMode === 'tree' && targetPage > 1 && targetPage <= AUTO_PRELOAD_PAGES) {
      pagesToLoad = [];
      for (let p = 1; p <= targetPage; p++) pagesToLoad.push(p);
    }
 
    return { targetPage, pagesToLoad, exactById: Boolean(exactPage) };
  }
 
  function applyRestoredScroll(target, { showNotice = true } = {}) {
    if (!target) {
      setBodyScrollTopProgrammatic(0);
      return;
    }
 
    const pNum = Number(target.postNumber || 1);
    if (pNum > 1) {
      const res = alignToAnchor(
        { postNumber: pNum, anchorOffset: target.anchorOffset },
        { allowNearest: true, highlight: true }
      );
      if (res.ok) {
        state.pendingRestoreAnchor = {
          postNumber: res.actualPostNumber || pNum,
          anchorOffset: res.desiredOffset,
        };
        const seq = state.requestSeq;
        requestAnimationFrame(() => {
          if (seq !== state.requestSeq || !state.isOpen || state.userHasScrolled) return;
          alignToAnchor(state.pendingRestoreAnchor, { allowNearest: true });
        });
        if (showNotice) {
          const shownFloor = res.actualPostNumber || pNum;
          showToast(`📍 已恢复上次浏览位置（#${shownFloor} 楼）`);
        }
        return;
      }
    }
 
    // 1 楼 OP 内滚动位置恢复
    const targetTop = Number.isFinite(target.scrollTop) ? Math.max(0, target.scrollTop) : 0;
    if (targetTop > 8) {
      setBodyScrollTopProgrammatic(targetTop);
      state.pendingRestoreAnchor = { postNumber: 1, anchorOffset: target.anchorOffset ?? (18 - targetTop) };
      if (showNotice && targetTop > 120) {
        showToast('📍 已恢复上次浏览位置');
      }
    } else {
      setBodyScrollTopProgrammatic(0);
    }
  }
 
  async function loadPagesAndRestoreTarget(tid, target, meta, seq, { showNotice = true } = {}) {
    if (target && typeof target.opExpanded === 'boolean') {
      state.opExpanded = target.opExpanded;
    }
 
    const plan = computeRestorePagePlan(tid, target);
    const nextLoaded = new Map();
 
    // 1. 先加载规划页（优先命中 /t/{tid}.json 已返回的第 1 页和 postByIdCache）
    let activeTargetPage = plan.targetPage;
    for (let i = 0; i < plan.pagesToLoad.length; i++) {
      const p = plan.pagesToLoad[i];
      if (p === 1 && (meta.initialCount > 0 || meta.replyStream.length === 0)) {
        nextLoaded.set(1, meta.page1Posts);
        continue;
      }
      const ids = getPagePostIds(p);
      if (!ids.length) {
        nextLoaded.set(p, []);
        continue;
      }
      const cached = isPageFullyCached(tid, p);
      if (!cached && i > 0) {
        await sleepMs(900);
        if (seq !== state.requestSeq || !state.isOpen) return false;
      }
      const posts = await fetchPostsByIds(tid, ids);
      if (seq !== state.requestSeq || !state.isOpen) return false;
      nextLoaded.set(p, posts);
    }
 
    // 2. 若目标页是按楼层号估算的（无 postId 且可能存在删楼偏移），校验目标楼层是否落在本页范围内，最多修正 3 步
    if (target && Number(target.postNumber) > 1 && !plan.exactById && state.totalPages > 1) {
      const wantNum = Number(target.postNumber);
      for (let hop = 0; hop < 3; hop++) {
        const curPosts = nextLoaded.get(activeTargetPage) || [];
        const nums = curPosts.map((x) => Number(x.post_number)).filter((n) => Number.isFinite(n) && n > 1);
        if (!nums.length) break;
        const minNum = Math.min(...nums);
        const maxNum = Math.max(...nums);
        let adjustPage = null;
        if (wantNum < minNum && activeTargetPage > 1) {
          adjustPage = activeTargetPage - 1;
        } else if (wantNum > maxNum && activeTargetPage < state.totalPages) {
          adjustPage = activeTargetPage + 1;
        }
        if (!adjustPage) break;
 
        if (!nextLoaded.has(adjustPage)) {
          if (adjustPage === 1 && (meta.initialCount > 0 || meta.replyStream.length === 0)) {
            nextLoaded.clear();
            nextLoaded.set(1, meta.page1Posts);
          } else {
            const ids = getPagePostIds(adjustPage);
            if (!isPageFullyCached(tid, adjustPage)) {
              await sleepMs(900);
              if (seq !== state.requestSeq || !state.isOpen) return false;
            }
            const posts = ids.length ? await fetchPostsByIds(tid, ids) : [];
            if (seq !== state.requestSeq || !state.isOpen) return false;
            nextLoaded.clear();
            nextLoaded.set(adjustPage, posts);
          }
        }
        activeTargetPage = adjustPage;
      }
    }
 
    state.loadedPostsByPage = nextLoaded;
    state.page = activeTargetPage;
    state.loading = false;
    renderModalContent(false);
    applyRestoredScroll(target, { showNotice });
    return true;
  }
 
  async function reconcileLoadedPagesWithFreshData(tid, freshMeta, seq) {
    if (state.onlyAuthor) {
      renderModalContent(true);
      return;
    }
 
    const existingPages = Array.from(state.loadedPostsByPage.keys()).sort((a, b) => a - b);
    const nextLoaded = new Map();
 
    for (const p of existingPages) {
      if (p > state.totalPages) continue;
      if (p === 1 && (freshMeta.initialCount > 0 || freshMeta.replyStream.length === 0)) {
        nextLoaded.set(1, freshMeta.page1Posts);
        continue;
      }
      const ids = getPagePostIds(p);
      if (!ids.length) {
        nextLoaded.set(p, []);
        continue;
      }
      if (isPageFullyCached(tid, p)) {
        const cachedPosts = ids.map((id) => postByIdCache.get(`${tid}:${id}`)).filter(Boolean);
        nextLoaded.set(p, cachedPosts);
      } else {
        try {
          const fetched = await fetchPostsByIds(tid, ids);
          if (seq !== state.requestSeq || !state.isOpen) return;
          nextLoaded.set(p, fetched);
        } catch {
          nextLoaded.set(p, state.loadedPostsByPage.get(p) || []);
        }
      }
    }
 
    if (nextLoaded.size === 0) {
      if (freshMeta.initialCount > 0 || freshMeta.replyStream.length === 0) {
        nextLoaded.set(1, freshMeta.page1Posts);
      }
      state.page = 1;
    } else {
      state.page = Math.max(1, Math.min(state.totalPages, state.page));
    }
 
    state.loadedPostsByPage = nextLoaded;
    state.loading = false;
    renderModalContent(true);
  }
 
  async function loadTopicInitial(forceHardRefresh = false) {
    stopLiveUpdates();
    stopReadTracker(true);
    state.batchCancelToken++;
    state.batchLoading = false;
    state.batchLabel = '';
    state.batchNotice = '';
    state.appendLoading = false;
    state.prependLoading = false;
    state.autoLoadPaused = false;
    state.autoLoadError = '';
    if (autoAppendCooldownTimer) {
      clearTimeout(autoAppendCooldownTimer);
      autoAppendCooldownTimer = null;
    }
    state.pendingNewCount = 0;
    state.pendingLatestPostNum = 0;
    state.positionReady = false;
    state.userHasScrolled = false;
    state.pendingRestoreAnchor = null;
    const seq = ++state.requestSeq;
    const tid = state.tid;
 
    // 每次重新打开帖子都清理热门精选/只看楼主缓存，确保拿到最新数据
    if (forceHardRefresh) {
      clearTopicCaches(tid, true);
    } else {
      summaryCache.delete(tid);
      const prefix = `${tid}:`;
      for (const k of Array.from(authorStreamCache.keys())) {
        if (k.startsWith(prefix)) authorStreamCache.delete(k);
      }
    }
 
    // Stale-While-Revalidate：如果本会话之前打开过该帖且目标页已命中缓存，直接秒开到上次浏览位置
    const cachedSnapshot = !forceHardRefresh ? topicMetaCache.get(tid) : null;
    const prevReplyCount = cachedSnapshot
      ? Math.max(0, Number(cachedSnapshot.posts_count || 1) - 1)
      : null;
 
    let restoredFromCache = false;
    let cacheRestoreTarget = null;
 
    if (cachedSnapshot) {
      const cachedMeta = applyTopicMetaOnly(cachedSnapshot);
      if (cachedMeta) {
        cacheRestoreTarget = resolveRestoreTarget({
          tid,
          explicitPostNumber: state.openExplicitPostNumber,
          isDirectPostLink: state.openIsDirectPostLink,
          topicData: cachedSnapshot,
        });
        const cachedPlan = computeRestorePagePlan(tid, cacheRestoreTarget);
        const canRestoreInstantly = cachedPlan.pagesToLoad.every(
          (p) => (p === 1 && (cachedMeta.initialCount > 0 || cachedMeta.replyStream.length === 0)) || isPageFullyCached(tid, p)
        );
        if (canRestoreInstantly) {
          state.revalidating = true;
          if (cacheRestoreTarget && typeof cacheRestoreTarget.opExpanded === 'boolean') {
            state.opExpanded = cacheRestoreTarget.opExpanded;
          }
          const instantLoaded = new Map();
          for (const p of cachedPlan.pagesToLoad) {
            if (p === 1 && (cachedMeta.initialCount > 0 || cachedMeta.replyStream.length === 0)) {
              instantLoaded.set(1, cachedMeta.page1Posts);
            } else {
              const ids = getPagePostIds(p);
              instantLoaded.set(p, ids.map((id) => postByIdCache.get(`${tid}:${id}`)).filter(Boolean));
            }
          }
          state.loadedPostsByPage = instantLoaded;
          state.page = cachedPlan.targetPage;
          state.loading = false;
          renderModalContent(false);
          applyRestoredScroll(cacheRestoreTarget, { showNotice: true });
          restoredFromCache = true;
          state.positionReady = true;
        } else {
          state.revalidating = true;
          renderLoading('正在恢复上次浏览位置...');
        }
      } else {
        state.revalidating = false;
        renderLoading('正在加载帖子正文与评论...');
      }
    } else {
      state.revalidating = false;
      renderLoading('正在加载帖子正文与评论...');
    }
 
    const cachedAgeMs = cachedSnapshot ? (Date.now() - Number(topicMetaFetchedAt.get(tid) || 0)) : Infinity;
    const canSkipFreshFetch = Boolean(
      !forceHardRefresh &&
      restoredFromCache &&
      cachedAgeMs < TOPIC_META_FRESH_MS
    );
 
    if (canSkipFreshFetch) {
      state.revalidating = false;
      state.openExplicitPostNumber = null;
      state.openIsDirectPostLink = false;
      renderModalContent(true);
      startLiveUpdates(tid);
      startReadTracker(tid);
      const loadedRange = getLoadedPageRange();
      const maxAutoPage = Math.min(AUTO_PRELOAD_PAGES, state.totalPages);
      if (
        seq === state.requestSeq &&
        state.isOpen &&
        state.totalPages > 1 &&
        state.loadedPostsByPage.has(1) &&
        loadedRange.max < maxAutoPage &&
        Date.now() >= globalRateLimitUntil
      ) {
        autoPreloadInitialPages();
      }
      return;
    }
 
    try {
      // 向服务端请求最新 /t/{tid}.json，保证 OP 编辑、新回复和服务端阅读进度最新
      const freshData = await fetchTopicInitial(tid, true);
      if (seq !== state.requestSeq || !state.isOpen) return;
 
      state.revalidating = false;
      const freshMeta = applyTopicMetaOnly(freshData);
      if (!freshMeta) {
        renderError('未能读取到帖子内容，请点击新标签页查看', `https://linux.do/t/topic/${tid}`);
        return;
      }
 
      const freshRestoreTarget = resolveRestoreTarget({
        tid,
        explicitPostNumber: state.openExplicitPostNumber,
        isDirectPostLink: state.openIsDirectPostLink,
        topicData: freshData,
      });
 
      const needJumpFurtherFromServer = Boolean(
        restoredFromCache &&
        !state.userHasScrolled &&
        freshRestoreTarget?.source === 'server' &&
        Number(freshRestoreTarget.postNumber || 0) > Number(cacheRestoreTarget?.postNumber || 1)
      );
 
      if (restoredFromCache && !needJumpFurtherFromServer) {
        await reconcileLoadedPagesWithFreshData(tid, freshMeta, seq);
        if (seq !== state.requestSeq || !state.isOpen) return;
      } else {
        const ok = await loadPagesAndRestoreTarget(tid, freshRestoreTarget, freshMeta, seq, {
          showNotice: !forceHardRefresh,
        });
        if (!ok || seq !== state.requestSeq || !state.isOpen) return;
        state.positionReady = true;
      }
 
      // 消费本次打开携带的一次性直达参数，避免后续刷新误跳
      state.openExplicitPostNumber = null;
      state.openIsDirectPostLink = false;
 
      // 如果重新打开时发现有新增回复，给出轻微提示
      if (prevReplyCount != null) {
        const latestReplyCount = Math.max(0, Number(freshData.posts_count || 1) - 1);
        const diff = latestReplyCount - prevReplyCount;
        if (diff > 0) {
          showToast(`✨ 已同步最新数据（新增 ${diff} 条回复）`);
        }
      }
 
      // 开启实时自动刷新（优先复用 Discourse MessageBus，失败则降级为低频轮询）
      startLiveUpdates(tid);
      // 启动原生阅读进度上报（POST /topics/timings），同步服务端已读状态并消除列表小蓝点
      startReadTracker(tid);
 
      // 仅当当前视图包含第 1 页且尚未预加载完前 AUTO_PRELOAD_PAGES 页时，后台串行预加载后续初始页
      const loadedRange = getLoadedPageRange();
      const maxAutoPage = Math.min(AUTO_PRELOAD_PAGES, state.totalPages);
      if (
        seq === state.requestSeq &&
        state.isOpen &&
        state.totalPages > 1 &&
        state.loadedPostsByPage.has(1) &&
        loadedRange.max < maxAutoPage &&
        Date.now() >= globalRateLimitUntil
      ) {
        autoPreloadInitialPages();
      }
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.revalidating = false;
      // 如果已有缓存快照展示，不清空界面，只给出温和提示
      if (cachedSnapshot && state.topic && restoredFromCache) {
        renderModalContent(true);
        showToast(`刷新失败：${err?.message || '网络异常'}`);
        startLiveUpdates(tid);
        startReadTracker(tid);
      } else {
        renderError(`加载失败（${err?.message || '网络异常'}）`, `https://linux.do/t/topic/${tid}`);
      }
    }
  }
 
  async function loadCommentPage(targetPage, { scrollToComments = false, replaceLoaded = true } = {}) {
    state.batchCancelToken++;
    state.batchLoading = false;
    state.batchNotice = '';
    state.appendLoading = false;
    state.prependLoading = false;
    state.autoLoadPaused = false;
    state.autoLoadError = '';
    state.userHasScrolled = true;
    state.pendingRestoreAnchor = null;
 
    const seq = ++state.requestSeq;
    const tid = state.tid;
    const page = Math.max(1, Math.min(state.totalPages, Number(targetPage) || 1));
    state.page = page;
    if (page >= state.totalPages) {
      state.pendingNewCount = 0;
      state.pendingLatestPostNum = 0;
    }
 
    const pageIds = getPagePostIds(page);
 
    state.loading = true;
    if (replaceLoaded) {
      state.loadedPostsByPage.clear();
    }
    renderModalContent(!scrollToComments);
    if (scrollToComments) scrollToCommentsTop();
 
    try {
      const posts = pageIds.length > 0 ? await fetchPostsByIds(tid, pageIds) : [];
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.loadedPostsByPage.set(page, posts);
      state.loading = false;
      renderModalContent(!scrollToComments && !replaceLoaded);
      if (scrollToComments) scrollToCommentsTop();
      scheduleSaveReadPosition();
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.loading = false;
      renderError(`加载第 ${page} 页评论失败（${err?.message || '网络异常'}）`, `https://linux.do/t/topic/${tid}`);
    }
  }
 
  let autoAppendCooldownTimer = null;
 
  function maybeTriggerInfiniteScroll() {
    if (!bodyEl || !state.isOpen || !state.positionReady) return;
    if (state.loading || state.batchLoading || state.appendLoading) return;
    if (state.tab !== 'all') return;
    const range = getLoadedPageRange();
    if (range.max >= state.totalPages) return;
 
    const now = Date.now();
    // 若先前因 429 暂停且已过冷却期，允许自动恢复下滑加载
    if (state.autoLoadPaused) {
      if (globalRateLimitUntil > now) return;
      if (state.autoLoadError && !/429/.test(state.autoLoadError)) return;
      state.autoLoadPaused = false;
      state.autoLoadError = '';
    }
 
    const remainingPx = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight;
    if (remainingPx > INFINITE_SCROLL_THRESHOLD_PX) return;
 
    const nextPage = range.max + 1;
    const cached = isPageFullyCached(state.tid, nextPage);
    if (!cached) {
      const lastNetAt = Math.max(state.lastAppendAt, lastApiRequestAt);
      const waitForPace = AUTO_APPEND_COOLDOWN_MS - (now - lastNetAt);
      const waitForLimit = globalRateLimitUntil - now;
      const waitMs = Math.max(waitForPace, waitForLimit);
      if (waitMs > 0) {
        if (!autoAppendCooldownTimer) {
          autoAppendCooldownTimer = setTimeout(() => {
            autoAppendCooldownTimer = null;
            maybeTriggerInfiniteScroll();
          }, waitMs + 40);
        }
        return;
      }
    }
 
    appendNextPage({ fromScroll: true });
  }
 
  async function appendNextPage({ fromScroll = false } = {}) {
    if (state.loading || state.batchLoading || state.appendLoading) return;
    const range = getLoadedPageRange();
    const nextPage = range.max + 1;
    if (nextPage > state.totalPages) return;
 
    if (!fromScroll) {
      state.autoLoadPaused = false;
      state.autoLoadError = '';
    }
 
    const seq = state.requestSeq;
    const tid = state.tid;
    const pageIds = getPagePostIds(nextPage);
    const wasCached = isPageFullyCached(tid, nextPage);
 
    state.appendLoading = true;
    // 原地更新底部状态条，避免发起请求前触发整页重绘闪烁
    const footerEl = bodyEl?.querySelector('#ldm-scroll-footer');
    if (footerEl) {
      footerEl.className = 'ldm-scroll-footer ldm-scroll-loading';
      footerEl.innerHTML = `<span class="ldm-spinner-sm"></span><span>正在加载第 ${nextPage} / ${state.totalPages} 页评论...</span>`;
    }
 
    try {
      const posts = pageIds.length > 0 ? await fetchPostsByIds(tid, pageIds) : [];
      if (seq !== state.requestSeq || !state.isOpen) return;
      if (!wasCached) state.lastAppendAt = Date.now();
      state.loadedPostsByPage.set(nextPage, posts);
      state.page = nextPage;
      state.appendLoading = false;
      state.autoLoadError = '';
      if (nextPage >= state.totalPages) {
        state.pendingNewCount = 0;
        state.pendingLatestPostNum = 0;
      }
      renderModalContent(true);
      scheduleSaveReadPosition();
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.appendLoading = false;
      state.autoLoadPaused = true;
      const is429 = err?.status === 429 || /429/.test(err?.message || '');
      if (is429) {
        const retrySec = Math.max(5, Math.ceil((err?.retryAfterMs || RATE_LIMIT_BACKOFF_MS) / 1000));
        state.autoLoadError = `触发站点请求频控 (429)，已暂停自动加载（约 ${retrySec} 秒后自动恢复）`;
      } else {
        state.autoLoadError = `加载第 ${nextPage} 页失败（${err?.message || '网络异常'}）`;
      }
      renderModalContent(true);
    }
  }
 
  async function prependPrevPage() {
    if (state.loading || state.batchLoading || state.prependLoading) return;
    const range = getLoadedPageRange();
    const prevPage = range.min - 1;
    if (prevPage < 1) return;
 
    const seq = state.requestSeq;
    const tid = state.tid;
    const pageIds = getPagePostIds(prevPage);
 
    state.prependLoading = true;
    const barBtn = bodyEl?.querySelector('#ldm-prepend-bar .ldm-prepend-btn');
    if (barBtn) {
      barBtn.disabled = true;
      barBtn.textContent = `正在加载第 ${prevPage} 页更早评论...`;
    }
 
    try {
      const posts = pageIds.length > 0 ? await fetchPostsByIds(tid, pageIds) : [];
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.loadedPostsByPage.set(prevPage, posts);
      state.prependLoading = false;
      // 借助楼层锚点保持当前正在阅读的楼层原地不动
      renderModalContent(true);
      scheduleSaveReadPosition();
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.prependLoading = false;
      renderModalContent(true);
      showToast(`加载第 ${prevPage} 页失败：${err?.message || '网络异常'}`);
    }
  }
 
  function isPageFullyCached(tid, pageNum) {
    const ids = getPagePostIds(pageNum);
    return ids.every((id) => postByIdCache.has(`${tid}:${id}`));
  }
 
  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
 
  /**
   * 串行节流分批加载指定页码并合并到当前楼中楼：
   * - 严格单并发（每次只发 1 个请求），页间间隔 750ms，避免触发 Linux.do 429 频控
   * - 命中本地缓存的页直接瞬间合并，不额外等待
   * - 遇到 429 立即优雅停止并保留已加载内容
   */
  async function runSequentialPageBatch(targetPages, { label, initialDelayMs = 0, stepDelayMs = BATCH_STEP_DELAY_MS, stepBackoffMs = 0, baseDone = 0, displayTotal = null } = {}) {
    if (!targetPages.length || state.batchLoading) return;
 
    const token = ++state.batchCancelToken;
    const seq = state.requestSeq;
    const tid = state.tid;
    const isActive = () => token === state.batchCancelToken && seq === state.requestSeq && state.isOpen;
 
    state.batchLoading = true;
    state.batchNotice = '';
    state.batchLabel = label || '正在分批合并加载评论';
    state.batchDone = baseDone;
    state.batchTotal = displayTotal ?? (baseDone + targetPages.length);
    renderModalContent(true);
 
    let needInitialWait = initialDelayMs > 0;
    let uncachedFetchedCount = 0;
 
    for (let i = 0; i < targetPages.length; i++) {
      if (!isActive()) return;
      const p = targetPages[i];
      const alreadyCached = isPageFullyCached(tid, p);
 
      if (!alreadyCached) {
        const now = Date.now();
        let targetGap = 0;
        let minWait = 0;
        if (needInitialWait) {
          needInitialWait = false;
          targetGap = initialDelayMs;
          minWait = initialDelayMs;
        } else {
          // 依次递增放缓后续页请求间隔，避免连续突发触发 429
          targetGap = Math.min(BATCH_MAX_STEP_DELAY_MS, stepDelayMs + uncachedFetchedCount * stepBackoffMs);
        }
        const paceRemain = Math.max(0, targetGap - (now - lastApiRequestAt));
        const limitRemain = Math.max(0, globalRateLimitUntil - now);
        const finalWait = Math.max(minWait, paceRemain, limitRemain);
        if (finalWait > 0) {
          await sleepMs(finalWait);
          if (!isActive()) return;
        }
      } else {
        needInitialWait = false;
      }
 
      const pageIds = getPagePostIds(p);
      try {
        const posts = pageIds.length > 0 ? await fetchPostsByIds(tid, pageIds) : [];
        if (!isActive()) return;
        if (!alreadyCached) {
          uncachedFetchedCount++;
          state.lastAppendAt = Date.now();
        }
        state.loadedPostsByPage.set(p, posts);
        state.page = Math.max(state.page, p);
        state.batchDone++;
        renderModalContent(true);
      } catch (err) {
        if (!isActive()) return;
        if (err?.status === 429 || /429/.test(err?.message || '')) {
          const retrySec = Math.max(5, Math.ceil((err?.retryAfterMs || RATE_LIMIT_BACKOFF_MS) / 1000));
          state.batchNotice = `触发站点请求频率限制 (429)，已自动暂停分批加载（约 ${retrySec} 秒后可继续）。`;
          state.autoLoadPaused = true;
          state.autoLoadError = `触发站点请求频控 (429)，已暂停自动加载（约 ${retrySec} 秒后自动恢复）`;
          break;
        }
        // 非 429 的单页网络异常，跳过并继续
        state.batchDone++;
        renderModalContent(true);
      }
    }
 
    if (isActive()) {
      state.batchLoading = false;
      state.batchLabel = '';
      renderModalContent(true);
      maybeTriggerInfiniteScroll();
    }
  }
 
  /**
   * 打开帖子后自动串行分批加载前 AUTO_PRELOAD_PAGES（默认 3）页评论，且逐页递增放缓间隔
   */
  async function autoPreloadInitialPages() {
    const maxPreload = Math.min(AUTO_PRELOAD_PAGES, state.totalPages);
    const pagesToFetch = [];
    for (let p = 2; p <= maxPreload; p++) {
      if (!state.loadedPostsByPage.has(p)) {
        pagesToFetch.push(p);
      }
    }
    if (!pagesToFetch.length) return;
 
    await runSequentialPageBatch(pagesToFetch, {
      label: `自动分批预加载前 ${maxPreload} 页评论`,
      initialDelayMs: AUTO_PRELOAD_INITIAL_DELAY_MS,
      stepDelayMs: BATCH_STEP_DELAY_MS,
      stepBackoffMs: AUTO_PRELOAD_STEP_BACKOFF_MS,
      baseDone: 1,
      displayTotal: maxPreload,
    });
  }
 
  async function startBatchMerge() {
    if (state.batchLoading || state.totalPages <= 1) return;
    const totalPages = state.totalPages;
    const range = getLoadedPageRange();
    const remainingPages = [];
 
    for (let p = range.max + 1; p <= totalPages; p++) {
      if (!state.loadedPostsByPage.has(p)) remainingPages.push(p);
    }
    for (let p = 1; p < range.max; p++) {
      if (!state.loadedPostsByPage.has(p)) remainingPages.push(p);
    }
    if (!remainingPages.length) return;
 
    const targetPages = remainingPages.length <= AUTO_ALL_THRESHOLD
      ? remainingPages
      : remainingPages.slice(0, BATCH_MERGE_SIZE);
 
    await runSequentialPageBatch(targetPages, {
      label: '正在分批合并多页楼中楼',
      initialDelayMs: 0,
      stepDelayMs: BATCH_STEP_DELAY_MS,
      stepBackoffMs: BATCH_STEP_BACKOFF_MS,
      baseDone: 0,
      displayTotal: targetPages.length,
    });
  }
 
  async function switchToSummary() {
    state.onlyAuthor = false;
    state.tab = 'summary';
    if (state.summaryPosts) {
      renderModalContent(true);
      return;
    }
    const seq = ++state.requestSeq;
    state.loading = true;
    renderModalContent(true);
    try {
      const posts = await fetchTopicSummary(state.tid, false);
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.summaryPosts = posts;
      state.loading = false;
      renderModalContent(true);
    } catch {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.summaryPosts = [];
      state.loading = false;
      renderModalContent(true);
    }
  }
 
  async function toggleOnlyAuthor() {
    state.onlyAuthor = !state.onlyAuthor;
    state.tab = 'all';
    state.batchCancelToken++;
    state.batchLoading = false;
    state.appendLoading = false;
    state.prependLoading = false;
    state.autoLoadPaused = false;
    state.autoLoadError = '';
 
    if (!state.onlyAuthor) {
      state.activeStream = state.replyStream;
      state.pageChunks = buildPageChunks(state.replyStream, 0);
      state.totalPages = Math.max(1, state.pageChunks.length);
      await loadCommentPage(1, { scrollToComments: true, replaceLoaded: true });
      return;
    }
 
    const opUsername = state.opPost?.username;
    if (!opUsername) return;
 
    const seq = ++state.requestSeq;
    state.loading = true;
    state.loadedPostsByPage.clear();
    renderModalContent(true);
 
    try {
      const filtered = await fetchAuthorFilteredStream(state.tid, opUsername, false);
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.activeStream = filtered.stream;
      state.pageChunks = buildPageChunks(filtered.stream, 0);
      state.totalPages = Math.max(1, state.pageChunks.length);
      state.page = 1;
      const page1Ids = new Set(getPagePostIds(1).map(Number));
      const page1Posts = filtered.posts.filter((p) => page1Ids.has(Number(p.id)));
      state.loadedPostsByPage = new Map([[1, page1Posts]]);
      state.loading = false;
      renderModalContent(false);
      scrollToCommentsTop();
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.loading = false;
      renderError(`筛选楼主回复失败（${err?.message || '网络异常'}）`, `https://linux.do/t/topic/${state.tid}`);
    }
  }
 
  async function handleExpandSubReplies(postId, btnEl, isSummaryToggle = false) {
    if (!postId || !state.tid) return;
    const key = `${state.tid}:${postId}`;
    const existing = subReplyCache.get(key);
 
    if (isSummaryToggle) {
      if (state.expandedSummarySubIds.has(String(postId))) {
        state.expandedSummarySubIds.delete(String(postId));
        renderModalContent(true);
        return;
      }
      if (existing && existing.loaded) {
        state.expandedSummarySubIds.add(String(postId));
        renderModalContent(true);
        return;
      }
    } else if (existing && existing.loaded) {
      renderModalContent(true);
      return;
    }
 
    const origHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<span class="ldm-gang"></span><span>正在加载楼中楼回复...</span>';
    }
 
    try {
      await fetchPostDirectReplies(state.tid, postId);
      if (isSummaryToggle) {
        state.expandedSummarySubIds.add(String(postId));
      }
      renderModalContent(true);
    } catch (err) {
      if (btnEl && btnEl.isConnected) {
        btnEl.disabled = false;
        btnEl.innerHTML = `<span class="ldm-gang"></span><span>加载失败（${escapeHtml(err?.message || '错误')}），点击重试</span>`;
        setTimeout(() => {
          if (btnEl.isConnected) btnEl.innerHTML = origHtml;
        }, 2500);
      }
    }
  }
 
  async function handleLoadCrossParent(postNumber, btnEl) {
    const pNum = Number(postNumber);
    if (!pNum || !state.tid) return;
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = `正在加载 #${pNum} 原楼...`;
    }
    try {
      const post = await fetchPostByNumber(state.tid, pNum);
      state.crossParentPosts.set(pNum, post);
      renderModalContent(true);
    } catch (err) {
      if (btnEl && btnEl.isConnected) {
        btnEl.disabled = false;
        btnEl.textContent = `加载 #${pNum} 失败（${err?.message || '错误'}），点击重试`;
      }
    }
  }
 
  function scrollToCommentsTop() {
    const anchor = bodyEl?.querySelector('#ldm-comments-anchor');
    if (anchor) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
 
  function openReplyComposer({ scopeKey, postNumber = null, username = '' }) {
    if (!state.topic || isTopicLocked()) return;
    // 如果再次点击同一个回复按钮且草稿为空，则收起回复框
    if (state.replyTarget && state.replyTarget.scopeKey === scopeKey && !state.replyDraft.trim()) {
      closeReplyComposer();
      return;
    }
    const isSameTarget = state.replyTarget && state.replyTarget.scopeKey === scopeKey;
    state.replyTarget = {
      scopeKey,
      postNumber: postNumber ? Number(postNumber) : null,
      username: username || '',
    };
    if (!isSameTarget) {
      state.replyError = '';
    }
    renderModalContent(true);
    const box = bodyEl?.querySelector('#ldm-reply-box');
    const ta = bodyEl?.querySelector('#ldm-reply-textarea');
    if (box) {
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (ta) {
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      try {
        ta.setSelectionRange(len, len);
      } catch {
        // ignore
      }
    }
  }
 
  function closeReplyComposer() {
    if (!state.replyTarget) return;
    state.replyTarget = null;
    state.replyDraft = '';
    state.replyError = '';
    state.replySubmitting = false;
    renderModalContent(true);
  }
 
  async function handleSubmitReply() {
    if (!state.replyTarget || state.replySubmitting || !state.tid) return;
    const raw = (state.replyDraft || '').trim();
    if (!raw) {
      state.replyError = '请输入回复内容';
      const errEl = bodyEl?.querySelector('#ldm-reply-error');
      if (errEl) errEl.textContent = state.replyError;
      return;
    }
 
    const target = state.replyTarget;
    const tid = state.tid;
    const seq = state.requestSeq;
 
    state.replySubmitting = true;
    state.replyError = '';
    renderModalContent(true);
 
    try {
      const newPost = await submitDiscourseReply({
        tid,
        raw,
        replyToPostNumber: target.postNumber,
      });
 
      if (seq !== state.requestSeq || !state.isOpen) return;
 
      // 立即将新回复合入当前界面状态（无需刷新页面）
      if (newPost && newPost.id) {
        if (state.topic) {
          state.topic.posts_count = Number(state.topic.posts_count || 1) + 1;
        }
        if (!state.replyStream.includes(newPost.id)) {
          state.replyStream.push(newPost.id);
        }
        if (!state.onlyAuthor && !state.activeStream.includes(newPost.id)) {
          state.activeStream.push(newPost.id);
          if (state.pageChunks.length === 0) {
            state.pageChunks.push([newPost.id]);
          } else {
            const lastChunk = state.pageChunks[state.pageChunks.length - 1];
            if (lastChunk.length < PAGE_SIZE) lastChunk.push(newPost.id);
            else state.pageChunks.push([newPost.id]);
          }
          state.totalPages = Math.max(1, state.pageChunks.length);
        }
 
        const parentNum = Number(target.postNumber || newPost.reply_to_post_number || 0);
        if (parentNum > 1) {
          const parentPost = postByNumberCache.get(`${tid}:${parentNum}`) || state.crossParentPosts.get(parentNum);
          if (parentPost && parentPost.id) {
            parentPost.reply_count = Number(parentPost.reply_count || 0) + 1;
            const subKey = `${tid}:${parentPost.id}`;
            const existingSub = subReplyCache.get(subKey);
            if (existingSub && Array.isArray(existingSub.list)) {
              if (!existingSub.list.some((x) => Number(x.id) === Number(newPost.id))) {
                existingSub.list.push(newPost);
              }
            } else if (state.tab === 'summary') {
              // 仅在热门精选区才需要临时塞入 subReplyCache 以便立即展示；保持 loaded: false 避免遮蔽其余未加载子回复
              subReplyCache.set(subKey, { list: [newPost], loaded: false });
            }
            if (state.tab === 'summary') {
              state.expandedSummarySubIds.add(String(parentPost.id));
            }
          }
        }
 
        // 同时追加到当前已加载的最后一个分页中，确保立即在楼中楼/平铺视图中可见
        const range = getLoadedPageRange();
        const targetPage = range.pages.length ? range.max : 1;
        const pageList = state.loadedPostsByPage.get(targetPage) || [];
        if (!pageList.some((x) => Number(x.id) === Number(newPost.id))) {
          state.loadedPostsByPage.set(targetPage, [...pageList, newPost]);
        }
      }
 
      // 清理缓存中的旧话题元数据，保证下次重新打开能看到最新回复
      topicMetaCache.delete(tid);
      topicMetaFetchedAt.delete(tid);
 
      state.replyTarget = null;
      state.replyDraft = '';
      state.replyError = '';
      state.replySubmitting = false;
      renderModalContent(true);
      showToast(newPost?.post_number ? `✨ 回复已发送 (#${newPost.post_number})` : '✨ 回复已发送');
    } catch (err) {
      if (seq !== state.requestSeq || !state.isOpen) return;
      state.replySubmitting = false;
      state.replyError = err?.message || '发送回复失败，请重试';
      renderModalContent(true);
    }
  }
 
  // ==================== 实时自动刷新引擎（MessageBus 优先 + 低频轮询兜底） ====================
  let activeBusChannel = null;
  let activeBusCallback = null;
  let busCreatedQueue = new Set();
  let busRevisedQueue = new Set();
  let busCreatedTimer = null;
  let busRevisedTimer = null;
  let pollTimer = null;
  let pollIntervalMs = POLL_BASE_INTERVAL_MS;
 
  function getDiscourseMessageBus() {
    try {
      const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (pageWin?.MessageBus && typeof pageWin.MessageBus.subscribe === 'function') {
        return pageWin.MessageBus;
      }
    } catch {
      // ignore sandbox access errors
    }
    if (window?.MessageBus && typeof window.MessageBus.subscribe === 'function') {
      return window.MessageBus;
    }
    return null;
  }
 
  function stopLiveUpdates() {
    if (activeBusChannel && activeBusCallback) {
      const mb = getDiscourseMessageBus();
      try {
        if (mb && typeof mb.unsubscribe === 'function') {
          mb.unsubscribe(activeBusChannel, activeBusCallback);
        }
      } catch {
        // ignore
      }
    }
    activeBusChannel = null;
    activeBusCallback = null;
    busCreatedQueue.clear();
    busRevisedQueue.clear();
    if (busCreatedTimer) {
      clearTimeout(busCreatedTimer);
      busCreatedTimer = null;
    }
    if (busRevisedTimer) {
      clearTimeout(busRevisedTimer);
      busRevisedTimer = null;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollIntervalMs = POLL_BASE_INTERVAL_MS;
    state.liveMode = 'none';
  }
 
  function startLiveUpdates(tid) {
    stopLiveUpdates();
    if (!state.isOpen || !state.liveUpdateEnabled || !tid || isTopicLocked()) return;
 
    const mb = getDiscourseMessageBus();
    if (mb) {
      const channel = `/topic/${tid}`;
      const handler = (data) => {
        if (!state.isOpen || !state.liveUpdateEnabled || String(state.tid) !== String(tid)) return;
        if (!data || typeof data !== 'object') return;
        const postId = Number(data.id);
        if (!postId) return;
 
        if (data.type === 'created') {
          if (state.replyStream.some((x) => Number(x) === postId)) return;
          busCreatedQueue.add(postId);
          if (!busCreatedTimer) {
            busCreatedTimer = setTimeout(() => {
              busCreatedTimer = null;
              const ids = Array.from(busCreatedQueue);
              busCreatedQueue.clear();
              if (ids.length) ingestLiveNewPostIds(tid, ids);
            }, 650);
          }
        } else if (data.type === 'revised' || data.type === 'rebaked') {
          busRevisedQueue.add(postId);
          if (!busRevisedTimer) {
            busRevisedTimer = setTimeout(() => {
              busRevisedTimer = null;
              const ids = Array.from(busRevisedQueue);
              busRevisedQueue.clear();
              if (ids.length) refreshRevisedPosts(tid, ids);
            }, 800);
          }
        }
      };
 
      try {
        // 传入 -1 仅订阅当前时刻之后的实时推送，不回放历史消息
        mb.subscribe(channel, handler, -1);
        activeBusChannel = channel;
        activeBusCallback = handler;
        state.liveMode = 'messagebus';
        return;
      } catch {
        // 订阅失败时降级到低频轮询
      }
    }
 
    // 兜底方案：当 MessageBus 不可访问时，在弹窗打开且标签页可见时低频轮询
    state.liveMode = 'polling';
    pollIntervalMs = POLL_BASE_INTERVAL_MS;
    scheduleNextPoll(tid);
  }
 
  function scheduleNextPoll(tid) {
    if (pollTimer) clearTimeout(pollTimer);
    if (!state.isOpen || !state.liveUpdateEnabled || String(state.tid) !== String(tid)) return;
    pollTimer = setTimeout(() => runPolitePoll(tid), pollIntervalMs);
  }
 
  async function runPolitePoll(tid) {
    pollTimer = null;
    if (!state.isOpen || !state.liveUpdateEnabled || String(state.tid) !== String(tid)) return;
    if (document.visibilityState !== 'visible') {
      scheduleNextPoll(tid);
      return;
    }
 
    try {
      const freshData = await fetchTopicInitial(tid, true);
      if (!state.isOpen || String(state.tid) !== String(tid)) return;
 
      const posts = Array.isArray(freshData?.post_stream?.posts) ? freshData.post_stream.posts : [];
      const stream = Array.isArray(freshData?.post_stream?.stream) ? freshData.post_stream.stream : [];
      const freshOp = posts.find((p) => Number(p.post_number) === 1);
      let opUpdated = false;
      if (freshOp && state.opPost && freshOp.updated_at !== state.opPost.updated_at) {
        state.opPost = freshOp;
        state.topic = freshData;
        opUpdated = true;
      }
 
      const opId = Number(state.opPost?.id || freshOp?.id || 0);
      const known = new Set(state.replyStream.map(Number));
      const newIds = stream.map(Number).filter((id) => id && id !== opId && !known.has(id));
 
      if (newIds.length > 0) {
        pollIntervalMs = POLL_BASE_INTERVAL_MS;
        await ingestLiveNewPostIds(tid, newIds);
      } else {
        // 无新回复时逐步退避间隔，降低请求频率
        pollIntervalMs = Math.min(POLL_MAX_INTERVAL_MS, pollIntervalMs + 10000);
        if (opUpdated) renderModalContent(true);
      }
      scheduleNextPoll(tid);
    } catch (err) {
      if (err?.status === 429 || /429/.test(err?.message || '')) {
        state.liveUpdateEnabled = false;
        stopLiveUpdates();
        renderModalContent(true);
        showToast('触发站点频控 (429)，已暂停自动实时更新');
        return;
      }
      pollIntervalMs = Math.min(POLL_MAX_INTERVAL_MS, pollIntervalMs + 15000);
      scheduleNextPoll(tid);
    }
  }
 
  async function ingestLiveNewPostIds(tid, incomingIds) {
    if (!state.isOpen || String(state.tid) !== String(tid) || !incomingIds.length) return;
    const known = new Set(state.replyStream.map(Number));
    const uniqueNewIds = incomingIds.map(Number).filter((id) => id && !known.has(id));
    if (!uniqueNewIds.length) return;
 
    try {
      const newPosts = await fetchPostsByIds(tid, uniqueNewIds, true);
      if (!state.isOpen || String(state.tid) !== String(tid) || !newPosts.length) return;
 
      const prevTotalPages = state.totalPages;
      const range = getLoadedPageRange();
      const viewingLatestPage = !state.onlyAuthor && state.tab === 'all' && range.max >= prevTotalPages;
 
      // 收集当前界面已加载的楼层号集合（用于判断新回复是否是某个可见楼层的楼中楼子回复）
      const visiblePostNums = new Set();
      for (const p of getLoadedPostsFlat()) {
        visiblePostNums.add(Number(p.post_number));
      }
 
      let mergedCount = 0;
      let deferredCount = 0;
      let latestPostNum = state.pendingLatestPostNum;
 
      for (const p of newPosts) {
        const pid = Number(p.id);
        if (state.replyStream.some((x) => Number(x) === pid)) continue;
 
        state.replyStream.push(pid);
        if (state.topic) {
          state.topic.posts_count = Math.max(Number(state.topic.posts_count || 1) + 1, state.replyStream.length + 1);
        }
        latestPostNum = Math.max(latestPostNum, Number(p.post_number || 0));
 
        if (!state.onlyAuthor) {
          state.activeStream.push(pid);
          if (state.pageChunks.length === 0) {
            state.pageChunks.push([pid]);
          } else {
            const lastChunk = state.pageChunks[state.pageChunks.length - 1];
            if (lastChunk.length < PAGE_SIZE) lastChunk.push(pid);
            else state.pageChunks.push([pid]);
          }
          state.totalPages = Math.max(1, state.pageChunks.length);
        }
 
        const parentNum = Number(p.reply_to_post_number || 0);
        const repliesToVisible = parentNum > 1 && visiblePostNums.has(parentNum);
 
        if (parentNum > 1) {
          const parentPost = postByNumberCache.get(`${tid}:${parentNum}`) || state.crossParentPosts.get(parentNum);
          if (parentPost && parentPost.id) {
            parentPost.reply_count = Number(parentPost.reply_count || 0) + 1;
            const subKey = `${tid}:${parentPost.id}`;
            const existingSub = subReplyCache.get(subKey);
            if (existingSub && Array.isArray(existingSub.list)) {
              if (!existingSub.list.some((x) => Number(x.id) === pid)) {
                existingSub.list.push(p);
              }
            }
          }
        }
 
        // 若正在看最后一页，或新回复是当前可见楼层的楼中楼回复，则直接无缝插入树中；否则弹出顶部新回复提示条
        if (viewingLatestPage || repliesToVisible) {
          const targetPage = viewingLatestPage ? state.totalPages : range.max;
          const list = state.loadedPostsByPage.get(targetPage) || [];
          if (!list.some((x) => Number(x.id) === pid)) {
            state.loadedPostsByPage.set(targetPage, [...list, p]);
          }
          visiblePostNums.add(Number(p.post_number));
          mergedCount++;
        } else {
          deferredCount++;
        }
      }
 
      topicMetaCache.delete(tid);
      topicMetaFetchedAt.delete(tid);
 
      if (deferredCount > 0) {
        state.pendingNewCount += deferredCount;
        state.pendingLatestPostNum = latestPostNum;
      }
 
      if (mergedCount > 0 || deferredCount > 0) {
        renderModalContent(true);
        if (mergedCount > 0) {
          showToast(`✨ 收到 ${mergedCount} 条新回复，已自动刷新`);
        }
      }
    } catch {
      // 静默忽略单次实时拉取异常
    }
  }
 
  async function refreshRevisedPosts(tid, postIds) {
    if (!state.isOpen || String(state.tid) !== String(tid) || !postIds.length) return;
    try {
      const updated = await fetchPostsByIds(tid, postIds, true);
      if (!state.isOpen || String(state.tid) !== String(tid) || !updated.length) return;
      let touched = false;
      for (const p of updated) {
        if (state.opPost && Number(p.id) === Number(state.opPost.id)) {
          state.opPost = p;
          touched = true;
          continue;
        }
        for (const [pageNum, list] of state.loadedPostsByPage.entries()) {
          const idx = list.findIndex((x) => Number(x.id) === Number(p.id));
          if (idx !== -1) {
            const copy = list.slice();
            copy[idx] = p;
            state.loadedPostsByPage.set(pageNum, copy);
            touched = true;
          }
        }
      }
      if (touched) {
        topicMetaCache.delete(tid);
        topicMetaFetchedAt.delete(tid);
        renderModalContent(true);
      }
    } catch {
      // ignore
    }
  }
 
  // ==================== 原生阅读进度上报（POST /topics/timings，同步已读与消除小蓝点） ====================
  const READ_TICK_MS = 1000;
  const READ_FIRST_FLUSH_MS = 2000;
  const READ_FLUSH_INTERVAL_MS = 8000;
  const MAX_TIMING_PER_FLUSH = 60000;
 
  const readTracker = {
    tid: null,
    highestPostNum: 0,
    maxReportedPostNum: 0,
    pendingTopicTime: 0,
    pendingTimings: new Map(), // postNumber -> ms
    tickTimer: null,
    flushTimer: null,
    disabledForSession: false,
  };
 
  function collectVisiblePostNumbersInModal() {
    if (!bodyEl || !state.isOpen) return [];
    const bodyRect = bodyEl.getBoundingClientRect();
    if (bodyRect.height <= 0) return [];
    const visible = [];
 
    const candidates = bodyEl.querySelectorAll('#ldm-op-article[data-pnum], .ldm-tree-node[data-pnum]');
    for (const el of candidates) {
      if (el.classList.contains('ldm-node-cross') && el.querySelector('[data-action="load-cross-parent"]')) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      // 只要该楼层与弹窗可视区域有交集，即视为正在阅读
      if (rect.bottom > bodyRect.top + 10 && rect.top < bodyRect.bottom - 10) {
        const pnum = parseInt(el.getAttribute('data-pnum'), 10);
        if (Number.isFinite(pnum) && pnum >= 1) {
          visible.push(pnum);
        }
      }
    }
    return visible;
  }
 
  function recordReadTick(ms = READ_TICK_MS) {
    if (!state.isOpen || !readTracker.tid || String(state.tid) !== String(readTracker.tid)) return;
    if (document.visibilityState !== 'visible') return;
 
    const visibleNums = collectVisiblePostNumbersInModal();
    if (!visibleNums.length) return;
 
    readTracker.pendingTopicTime = Math.min(MAX_TIMING_PER_FLUSH, readTracker.pendingTopicTime + ms);
    for (const pnum of visibleNums) {
      const prev = readTracker.pendingTimings.get(pnum) || 0;
      readTracker.pendingTimings.set(pnum, Math.min(MAX_TIMING_PER_FLUSH, prev + ms));
    }
  }
 
  function syncListRowReadUI(tid, maxReadPostNum) {
    if (!tid) return;
    const rows = document.querySelectorAll(
      `tr.topic-list-item[data-topic-id="${tid}"], .latest-topic-list-item[data-topic-id="${tid}"]`
    );
    const highest = Math.max(
      Number(readTracker.highestPostNum || 0),
      Number(state.topic?.highest_post_number || state.topic?.posts_count || 0)
    );
 
    ldmLog('syncListRowReadUI', { tid, maxReadPostNum, highest, matchedRows: rows.length });
 
    rows.forEach((row) => {
      row.classList.add('visited');
      row.classList.remove('unseen-topic');
      // 严禁调用 badge.remove() 或改写 badge.textContent！
      // Discourse 基于 Ember/Glimmer 维护内部节点与文本锚点引用，直接删节点会导致 removeChild NotFoundError 崩溃。
      row.querySelectorAll('.badge-notification.new-topic').forEach((badge) => {
        badge.classList.add('ldm-badge-hidden');
      });
 
      // 若有未读回复数字角标，仅通过 CSS 类与 data 属性视觉更新，保持底层 DOM 完整
      row.querySelectorAll('.badge-notification.unread-posts').forEach((badge) => {
        if (highest > 0 && maxReadPostNum >= highest) {
          badge.classList.add('ldm-badge-hidden');
          badge.classList.remove('ldm-badge-count-override');
          badge.removeAttribute('data-ldm-unread');
        } else if (highest > 0 && maxReadPostNum > 1) {
          const remaining = Math.max(0, highest - maxReadPostNum);
          if (remaining === 0) {
            badge.classList.add('ldm-badge-hidden');
            badge.classList.remove('ldm-badge-count-override');
            badge.removeAttribute('data-ldm-unread');
          } else {
            badge.classList.remove('ldm-badge-hidden');
            badge.classList.add('ldm-badge-count-override');
            badge.setAttribute('data-ldm-unread', String(remaining));
          }
        }
      });
    });
  }
 
  async function flushReadTimings(useKeepalive = false) {
    const tid = readTracker.tid;
    if (!tid || readTracker.disabledForSession) return;
    if (readTracker.pendingTimings.size === 0 || readTracker.pendingTopicTime <= 0) return;
 
    // 复制并立即清空待上报队列，避免并发重复上报
    const topicTime = Math.max(500, Math.min(MAX_TIMING_PER_FLUSH, Math.round(readTracker.pendingTopicTime)));
    const timingsObj = {};
    let batchMaxPostNum = readTracker.maxReportedPostNum;
    for (const [pnum, ms] of readTracker.pendingTimings.entries()) {
      const clamped = Math.max(500, Math.min(MAX_TIMING_PER_FLUSH, Math.round(ms)));
      timingsObj[String(pnum)] = clamped;
      if (pnum > batchMaxPostNum) batchMaxPostNum = pnum;
    }
    readTracker.pendingTopicTime = 0;
    readTracker.pendingTimings.clear();
 
    try {
      const metaCsrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
      const csrf = metaCsrf || (useKeepalive ? '' : await getCsrfToken());
      if (!csrf) return;
 
      const resp = await fetch('/topics/timings', {
        method: 'POST',
        credentials: 'include',
        keepalive: Boolean(useKeepalive),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': csrf,
          'X-Requested-With': 'XMLHttpRequest',
          'X-SILENCE-LOGGER': 'true',
        },
        body: JSON.stringify({
          topic_id: Number(tid),
          topic_time: topicTime,
          timings: timingsObj,
        }),
      });
 
      if (resp.ok) {
        readTracker.maxReportedPostNum = Math.max(readTracker.maxReportedPostNum, batchMaxPostNum);
        if (state.topic && String(state.tid) === String(tid)) {
          state.topic.last_read_post_number = Math.max(
            Number(state.topic.last_read_post_number || 0),
            readTracker.maxReportedPostNum
          );
        }
        const cachedMeta = topicMetaCache.get(String(tid));
        if (cachedMeta) {
          cachedMeta.last_read_post_number = Math.max(
            Number(cachedMeta.last_read_post_number || 0),
            readTracker.maxReportedPostNum
          );
        }
        syncListRowReadUI(tid, readTracker.maxReportedPostNum);
      } else if (resp.status === 401 || resp.status === 403) {
        // 未登录用户无需继续上报阅读计时
        readTracker.disabledForSession = true;
      }
    } catch {
      // 静默忽略单次计时上报异常，不影响正常阅读
    }
  }
 
  function startReadTracker(tid) {
    stopReadTracker(false);
    if (!state.isOpen || !tid || readTracker.disabledForSession) return;
 
    readTracker.tid = String(tid);
    readTracker.highestPostNum = Number(state.topic?.highest_post_number || state.topic?.posts_count || 1);
    readTracker.maxReportedPostNum = Number(state.topic?.last_read_post_number || 0);
    readTracker.pendingTopicTime = READ_TICK_MS;
    readTracker.pendingTimings.clear();
    // 打开即记录 1 楼正在阅读，并统计当前屏内可见楼层
    readTracker.pendingTimings.set(1, READ_TICK_MS);
    for (const pnum of collectVisiblePostNumbersInModal()) {
      if (!readTracker.pendingTimings.has(pnum)) {
        readTracker.pendingTimings.set(pnum, READ_TICK_MS);
      }
    }
 
    readTracker.tickTimer = setInterval(() => {
      recordReadTick(READ_TICK_MS);
    }, READ_TICK_MS);
 
    // 首次 2 秒后快速上报一次（立即消除未读小蓝点），之后每 8 秒常规上报阅读进度
    readTracker.flushTimer = setTimeout(() => {
      flushReadTimings(false);
      if (readTracker.tid === String(tid) && state.isOpen) {
        readTracker.flushTimer = setInterval(() => {
          flushReadTimings(false);
        }, READ_FLUSH_INTERVAL_MS);
      }
    }, READ_FIRST_FLUSH_MS);
  }
 
  function stopReadTracker(flushBeforeStop = true) {
    if (readTracker.tickTimer) {
      clearInterval(readTracker.tickTimer);
      readTracker.tickTimer = null;
    }
    if (readTracker.flushTimer) {
      clearTimeout(readTracker.flushTimer);
      clearInterval(readTracker.flushTimer);
      readTracker.flushTimer = null;
    }
    if (flushBeforeStop && readTracker.tid) {
      // 关闭/切换前先采集一次当前屏幕可见楼层，避免最后不到 1 秒的浏览漏报
      recordReadTick(READ_TICK_MS);
      flushReadTimings(true);
    } else {
      readTracker.pendingTopicTime = 0;
      readTracker.pendingTimings.clear();
    }
    readTracker.tid = null;
    readTracker.highestPostNum = 0;
    readTracker.maxReportedPostNum = 0;
  }
 
  function closeModal() {
    if (!state.isOpen) return;
    ldmLog('closeModal', {
      tid: state.tid,
      pathname: location.pathname,
      activeElement: document.activeElement?.tagName,
      activeId: document.activeElement?.id || '',
    });
    // 关闭弹窗清空 DOM 之前，立即保存当前浏览位置
    saveCurrentReadPosition(true);
    stopLiveUpdates();
    stopReadTracker(true);
    closeLightbox();
    state.isOpen = false;
    state.positionReady = false;
    state.pendingRestoreAnchor = null;
    state.requestSeq++;
    state.batchCancelToken++;
    state.batchLoading = false;
    state.appendLoading = false;
    state.prependLoading = false;
    state.autoLoadPaused = false;
    state.autoLoadError = '';
    if (autoAppendCooldownTimer) {
      clearTimeout(autoAppendCooldownTimer);
      autoAppendCooldownTimer = null;
    }
    state.revalidating = false;
    state.pendingNewCount = 0;
    state.pendingLatestPostNum = 0;
    state.replyTarget = null;
    state.replyDraft = '';
    state.replyError = '';
    state.replySubmitting = false;
    overlayEl.classList.remove('ldm-open');
    document.body.style.overflow = state.prevBodyOverflow;
    bodyEl.innerHTML = '';
  }
 
  function navigateAdjacent(delta) {
    if (!state.topicList.length || state.currentIndex < 0) return;
    const nextIdx = state.currentIndex + delta;
    if (nextIdx < 0 || nextIdx >= state.topicList.length) return;
    const target = state.topicList[nextIdx];
    openTopicModal(target.tid, target.title);
  }
 
  function handleBodyClick(e) {
    // 1. 点击 Discourse lightbox 链接或正文图片 -> 弹窗灯箱看大图
    const img = e.target.closest('img.ldm-zoomable-img');
    if (img) {
      const parentLightboxLink = img.closest('a.lightbox');
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img.src, parentLightboxLink?.href || img.src);
      return;
    }
 
    // 2. 点击普通外链时不触发折叠等外层操作
    if (e.target.closest('a[href]')) return;
 
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
 
    const action = actionEl.getAttribute('data-action');
    switch (action) {
      case 'open-reply': {
        const scopeKey = actionEl.getAttribute('data-scopekey') || 'topic';
        const pnumRaw = actionEl.getAttribute('data-pnum');
        const username = actionEl.getAttribute('data-username') || '';
        openReplyComposer({
          scopeKey,
          postNumber: pnumRaw ? parseInt(pnumRaw, 10) : null,
          username,
        });
        break;
      }
 
      case 'close-reply':
        closeReplyComposer();
        break;
 
      case 'submit-reply':
        handleSubmitReply();
        break;
 
      case 'toggle-op-expand':
        state.opExpanded = !state.opExpanded;
        syncOpCollapseState();
        if (!state.opExpanded && bodyEl.scrollTop > 220) {
          bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
        }
        scheduleSaveReadPosition();
        break;
 
      case 'toggle-collapse': {
        const ckey = actionEl.getAttribute('data-ckey');
        if (!ckey) return;
        if (state.collapsedKeys.has(ckey)) state.collapsedKeys.delete(ckey);
        else state.collapsedKeys.add(ckey);
        renderModalContent(true);
        break;
      }
 
      case 'expand-all-nodes':
        state.collapsedKeys.clear();
        renderModalContent(true);
        break;
 
      case 'mode-tree':
        if (state.viewMode !== 'tree') {
          state.viewMode = 'tree';
          renderModalContent(true);
        }
        break;
 
      case 'mode-flat':
        if (state.viewMode !== 'flat') {
          state.viewMode = 'flat';
          renderModalContent(true);
        }
        break;
 
      case 'tab-all':
        if (state.onlyAuthor) {
          toggleOnlyAuthor();
        } else if (state.tab !== 'all') {
          state.tab = 'all';
          renderModalContent(true);
        }
        break;
 
      case 'tab-summary':
        switchToSummary();
        break;
 
      case 'toggle-author':
        toggleOnlyAuthor();
        break;
 
      case 'append-next-page':
        appendNextPage({ fromScroll: false });
        break;
 
      case 'prepend-prev-page':
        prependPrevPage();
        break;
 
      case 'goto-first-page':
        loadCommentPage(1, { scrollToComments: true, replaceLoaded: true });
        break;
 
      case 'batch-merge':
        startBatchMerge();
        break;
 
      case 'cancel-batch':
        state.batchCancelToken++;
        state.batchLoading = false;
        state.batchLabel = '';
        state.batchNotice = '';
        renderModalContent(true);
        break;
 
      case 'toggle-default-op':
        state.defaultCollapseOp = !state.defaultCollapseOp;
        saveDefaultCollapseOp(state.defaultCollapseOp);
        state.opExpanded = !state.defaultCollapseOp;
        renderModalContent(true);
        showToast(state.defaultCollapseOp ? '已设为打开帖子默认收缩长正文' : '已设为打开帖子默认展开全文');
        break;
 
      case 'toggle-live':
        state.liveUpdateEnabled = !state.liveUpdateEnabled;
        if (state.liveUpdateEnabled) {
          startLiveUpdates(state.tid);
          showToast('🟢 已开启评论实时自动刷新');
        } else {
          stopLiveUpdates();
          renderModalContent(true);
          showToast('⏸ 已暂停评论实时自动刷新');
        }
        break;
 
      case 'goto-latest-new':
        state.pendingNewCount = 0;
        state.pendingLatestPostNum = 0;
        state.onlyAuthor = false;
        state.tab = 'all';
        loadCommentPage(state.totalPages, { scrollToComments: true, replaceLoaded: true });
        break;
 
      case 'refresh':
        saveCurrentReadPosition(true);
        loadTopicInitial(true);
        break;
 
      case 'expand-sub':
        handleExpandSubReplies(actionEl.getAttribute('data-postid'), actionEl, false);
        break;
 
      case 'toggle-summary-sub':
        handleExpandSubReplies(actionEl.getAttribute('data-postid'), actionEl, true);
        break;
 
      case 'load-cross-parent':
        handleLoadCrossParent(actionEl.getAttribute('data-pnum'), actionEl);
        break;
    }
  }
 
  // ==================== 全局事件监听（适配 Discourse SPA 路由） ====================
  function onDocumentClick(e) {
    // 仅拦截普通左键点击；Ctrl/Cmd/Shift/Alt + 点击或中键保留浏览器默认行为
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!targetEl) return;
    if (targetEl.closest('#ldm-overlay') || targetEl.closest('#ldm-lightbox')) return;
 
    // 已经处于独立帖子详情页时，不拦截页内链接
    if (TOPIC_URL_RE.test(location.pathname)) return;
    // 不拦截顶部导航栏/搜索下拉菜单/通知面板中的链接
    if (targetEl.closest('.d-header, .menu-panel, .search-menu, .user-menu')) return;
 
    const anchor = targetEl.closest('a[href]');
    if (!anchor) return;
 
    const info = extractTopicFromAnchor(anchor);
    if (!info) return;
 
    const isTitleLink = Boolean(
      anchor.classList.contains('raw-topic-link') ||
      anchor.classList.contains('title') ||
      anchor.closest('.link-top-line')
    );
    const isDirectPostLink = !isTitleLink && Boolean(info.postNumber && info.postNumber > 1);
    const rowTitleEl = !isTitleLink
      ? anchor.closest('tr, .latest-topic-list-item')?.querySelector('a.raw-topic-link, a.title')
      : null;
    const title = ((rowTitleEl || anchor).textContent || '').replace(/\s+/g, ' ').trim();
 
    e.preventDefault();
    e.stopPropagation();
    openTopicModal(info.tid, title, {
      explicitPostNumber: info.postNumber,
      isDirectPostLink,
    });
  }
 
  function onKeyDown(e) {
    if (!state.isOpen) return;
 
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (lightboxEl && lightboxEl.classList.contains('ldm-open')) {
        closeLightbox();
      } else if (state.replyTarget && !state.replySubmitting) {
        closeReplyComposer();
      } else {
        closeModal();
      }
      return;
    }
 
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      e.stopPropagation();
      return;
    }
    if (lightboxEl && lightboxEl.classList.contains('ldm-open')) {
      e.stopPropagation();
      return;
    }
 
    if (
      e.key === 'PageDown' ||
      e.key === 'PageUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Home' ||
      e.key === 'End' ||
      e.key === ' '
    ) {
      state.userHasScrolled = true;
      state.pendingRestoreAnchor = null;
      e.stopPropagation();
      return;
    }
 
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      navigateAdjacent(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      navigateAdjacent(1);
      return;
    }
 
    // 弹窗打开期间拦截无修饰键的单键事件冒泡，防止触发 Discourse 底层快捷键（如 p 打开右上角头像菜单）
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
    }
  }
 
  // ==================== 初始化 ====================
  injectStyles(STYLES);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('popstate', () => {
    ldmLog('popstate', { pathname: location.pathname, isOpen: state.isOpen });
    if (state.isOpen) closeModal();
  });
 
  // 诊断探针：监控详情页任意点击与右上角头像触发情况，辅助排查异常点击
  if (LDM_DIAG_LOG) {
    document.addEventListener('click', (e) => {
      const targetEl = e.target instanceof Element ? e.target : e.target?.parentElement;
      const inTopicPage = TOPIC_URL_RE.test(location.pathname);
      const hitCurrentUser = Boolean(targetEl?.closest?.('#current-user, #toggle-current-user, .current-user, .user-menu'));
      if (!inTopicPage && !hitCurrentUser) return;
 
      const menuWasOpen = Boolean(document.querySelector('.user-menu.revamped, .menu-panel.user-menu, #current-user.active'));
      const topEls = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(e.clientX, e.clientY).slice(0, 6).map((el) => {
            const idPart = el.id ? `#${el.id}` : '';
            const clsPart = typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
              : '';
            return `${el.tagName.toLowerCase()}${idPart}${clsPart}`;
          })
        : [];
 
      ldmLog('click-capture', {
        pathname: location.pathname,
        isOpen: state.isOpen,
        overlayDisplay: overlayEl ? getComputedStyle(overlayEl).display : 'none(not-created)',
        target: targetEl ? `${targetEl.tagName.toLowerCase()}${targetEl.id ? '#' + targetEl.id : ''}.${String(targetEl.className || '').trim()}` : String(e.target),
        activeElement: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? '#' + document.activeElement.id : ''}` : null,
        point: [Math.round(e.clientX), Math.round(e.clientY)],
        topEls,
        menuWasOpen,
      });
 
      // 点击冒泡结束后检查右上角头像菜单是否被意外打开
      setTimeout(() => {
        const menuNowOpen = Boolean(document.querySelector('.user-menu.revamped, .menu-panel.user-menu, #current-user.active'));
        if (!menuWasOpen && menuNowOpen && !hitCurrentUser) {
          console.warn('[LDM][ANOMALY] 点击非头像区域后右上角用户菜单被意外打开！', {
            pathname: location.pathname,
            target: targetEl,
            topEls,
            activeElementNow: document.activeElement,
          });
        }
      }, 60);
    }, true);
  }
  window.addEventListener('pagehide', () => {
    saveCurrentReadPosition(true);
    stopReadTracker(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.isOpen) {
      saveCurrentReadPosition(true);
    }
  });
 
  applyVisitedStyles();
  let styleTimer = null;
  const observer = new MutationObserver(() => {
    if (styleTimer) return;
    styleTimer = setTimeout(() => {
      styleTimer = null;
      applyVisitedStyles();
    }, 350);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
