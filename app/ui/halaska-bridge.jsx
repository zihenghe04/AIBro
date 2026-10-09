import React, { createElement, isValidElement, cloneElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  tokens, motion, usePal, ThemeProvider, AccentContext,
  Text, Heading, Label, Caption, Code,
  Button, IconButton, ButtonGroup, LinkButton,
  Card, CardHeader, Divider, Stack, Badge, Tag, StatusBadge, StatusDot,
  Avatar, AvatarGroup, ListItem, Stat, Table, ScrollArea,
  Pagination, MiddleTruncate, Kbd, Sparkline,
  Progress, ProgressCircle, Skeleton, Spinner, Toast, AlertBanner,
  EmptyState, Stepper,
  Orb, ThinkingIndicator, ThinkingSteps, ConfidenceBar, AISuggestionBadge, AgentGlyph,
} from './halaska-kit.jsx';
import { AgentLifecycleSummary, AgentLifecycleActions, AgentReceipt, AgentActivitySummary, AgentProcessTabs } from './agent-lifecycle.jsx';
import { KitChoicebox, KitCheckbox, KitSwitch, KitRadioGroup, KitSegmentedControl, KitTabs, KitPermissionPicker, KitReadConfirmation, KitSearchInput, KitSelect } from './kit-controls.jsx';
import { ReviewSummary, ReviewHeading, ReviewModeControl, ReviewDiffTools, ReviewActions, ReviewEmptyState, ReviewChangeCard } from './review-surfaces.jsx';
import { LibraryToolbar, LibrarySelection, LibraryEmpty, ProjectSourceActions, ProjectMetrics } from './project-surfaces.jsx';
import { CloudSyncOverview, CloudSSHConnection } from './cloud-surfaces.jsx';
import { ConnectionSyncSettingsSurface } from './connection-sync-settings.jsx';
import { CloudSSHStorage, CloudAccountConnection } from './cloud-maintenance-surfaces.jsx';
import { CloudConflictReview } from './cloud-conflict-review.jsx';
import { ConversationOrganizerView } from './conversation-organizer.jsx';
import { CommandSearchResults } from './command-search.jsx';
import { QueueSurface } from './queue-surfaces.jsx';
import { FeedbackActions, FeedbackEditor } from './feedback-surfaces.jsx';
import { CitationPeek, CitationSourceList } from './citation-surfaces.jsx';
import { CanvasEditSurface } from './canvas-edit-surfaces.jsx';
import { PlanReviewSurface } from './plan-review-surfaces.jsx';
import { ActivityCenterSurface, ActivityCenterBadge } from './activity-center-surfaces.jsx';
import { ComparisonPicker, SourceComparisonSurface } from './comparison-surfaces.jsx';
import { ContextWorkbenchSurface } from './context-surfaces.jsx';
import { PDFReaderToolbar } from './pdf-reader-surfaces.jsx';
import { ComposerEditor, ComposerAction, ComposerDictationStatus, PdfReadModeControl } from './composer-surfaces.jsx';
import { MessageActionBar } from './message-actions.jsx';
import { ModelPickerSurface } from './model-picker-surfaces.jsx';
import { ClaudeAuthSurface } from './claude-auth-surface.jsx';
import { BenchoAddMenu } from './bencho-add-menu.jsx';
import { ResearchWikiHeader, ResearchWikiCards, ResearchWikiComposer } from './research-wiki-surfaces.jsx';
import { APIProfileBar } from './api-profile-surfaces.jsx';
import { ModelSettingsSurface } from './model-settings-surfaces.jsx';
import { SettingsNavigation } from './settings-workspace-surfaces.jsx';
import { ImportSurface } from './import-surfaces.jsx';
import { RunHistoryToolbar, RunHistoryList, RunHistoryDetail } from './history-surfaces.jsx';
import { ConversationReadingMode } from './conversation-reading-mode.jsx';
import { RunCheckpointCard } from './run-checkpoint-card.jsx';
import { NoteDraftRecovery } from './note-draft-recovery.jsx';
import { ArtifactProvenanceSurface } from './artifact-provenance-surfaces.jsx';
import { DocumentToolbar } from './document-toolbar.jsx';
import { DocumentFiles } from './document-files.jsx';
import { ProjectBoardPanel } from './project-board.jsx';
import { ProjectScheduleSurface } from './project-schedule.jsx';
import { TaskCreateForm } from './task-create.jsx';
import { TaskDetailSurface } from './task-detail.jsx';
import { ProjectOverview } from './project-overview.jsx';
import { ProjectOutputsPanel } from './project-outputs.jsx';
import { LibraryDataTable } from './library-data-table.jsx';
import { ProjectMemoryActions } from './project-memory-actions.jsx';
import { ProjectLibraryNavigation, ProjectLibraryBreadcrumb } from './project-library.jsx';
import hostStyles from './halaska-host.css';

// Only data-driven primitives verified for incremental adoption are mountable.
// Patterns with sample data/timers and unreviewed overlays stay in the original
// source, rather than quietly becoming application behavior.
const components = new Map(Object.entries({
  Text, Heading, Label, Caption, Code, Button, IconButton, ButtonGroup, LinkButton,
  Card, CardHeader, Divider, Stack, Badge, Tag, StatusBadge, StatusDot,
  Avatar, AvatarGroup, ListItem, Stat, Table, ScrollArea, Pagination, MiddleTruncate,
  Kbd, Sparkline, Progress, ProgressCircle, Skeleton, Spinner, Toast, AlertBanner,
  EmptyState, Stepper, Orb, ThinkingIndicator, ThinkingSteps, ConfidenceBar,
  AISuggestionBadge, AgentGlyph,
  AgentLifecycleSummary, AgentLifecycleActions, AgentReceipt, AgentActivitySummary, AgentProcessTabs,
  KitChoicebox, KitCheckbox, KitSwitch, KitRadioGroup, KitSegmentedControl, KitTabs, KitPermissionPicker, KitReadConfirmation, KitSearchInput, KitSelect,
  ProjectLibraryNavigation, ProjectLibraryBreadcrumb, LibraryDataTable, ProjectMemoryActions, ProjectOverview, TaskCreateForm, TaskDetailSurface, ProjectBoard: ProjectBoardPanel, ProjectScheduleSurface,
  LibraryToolbar, LibrarySelection, LibraryEmpty, ProjectSourceActions, ProjectMetrics, CloudSyncOverview, CloudSSHConnection, CloudSSHStorage, CloudAccountConnection, CloudConflictReview, ConnectionSyncSettingsSurface, ConversationOrganizerView, CommandSearchResults, QueueSurface,
  FeedbackActions, FeedbackEditor,
  MessageActionBar, ClaudeAuthSurface,
  CitationPeek, CitationSourceList,
  CanvasEditSurface, ContextWorkbenchSurface, PDFReaderToolbar, ComposerEditor, ComposerAction, ComposerDictationStatus, PdfReadModeControl, ModelPickerSurface, BenchoAddMenu, ResearchWikiHeader, ResearchWikiCards, ResearchWikiComposer,
  PlanReviewSurface, ActivityCenterSurface, ActivityCenterBadge, ComparisonPicker, SourceComparisonSurface, APIProfileBar, ModelSettingsSurface, SettingsNavigation, ImportSurface,
  ReviewSummary, ReviewHeading, ReviewModeControl, ReviewDiffTools, ReviewActions, ReviewEmptyState, ReviewChangeCard,
  RunHistoryToolbar, RunHistoryList, RunHistoryDetail, ConversationReadingMode, RunCheckpointCard, NoteDraftRecovery, ArtifactProvenanceSurface, DocumentToolbar, DocumentFiles, ProjectOutputs: ProjectOutputsPanel,
}));
const mounts = new Map();
const style = document.createElement('style');
style.id = 'halaska-host-styles';
style.textContent = hostStyles;
document.head.appendChild(style);

function component(name) {
  const value = components.get(name);
  if (!value) throw new Error(`HalaskaUI: ${String(name)} is not an approved component. Adapt and verify its real data flow before registering it.`);
  return value;
}

function valueNode(value, key) {
  if (isValidElement(value)) return key == null ? value : cloneElement(value, { key: value.key ?? key });
  if (Array.isArray(value)) return value.map((item, index) => valueNode(item, index));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.component === 'string') {
    const props = convertProps(value.props || {});
    return createElement(component(value.component), { ...props, key: value.key ?? key });
  }
  if (Object.getPrototypeOf(value) === Object.prototype) return convertProps(value);
  return value;
}

function convertProps(props) {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, valueNode(value)]));
}

function currentTheme() {
  return document.body.classList.contains('light-mode') ? 'light' : 'dark';
}

function render(record) {
  const props = convertProps(record.props);
  const theme = props.theme || currentTheme();
  record.element.dataset.halaskaTheme = theme;
  // Preserve component state across calls and theme changes; routing and data
  // remain owned by the existing workstation. Synchronous DOM is intentional.
  flushSync(() => record.root.render(createElement(ThemeProvider, { theme },
    createElement(component(record.name), props))));
}

function mount(element, name, props = {}) {
  if (!(element instanceof Element)) throw new TypeError('HalaskaUI.mount requires a DOM element');
  component(name);
  const existing = mounts.get(element);
  if (existing) {
    existing.name = name;
    existing.props = props;
    render(existing);
  } else {
    if (element.childNodes.length) throw new Error('HalaskaUI.mount requires an empty host; it must not replace existing stateful DOM');
    const record = { element, name, props, root: createRoot(element), connected: element.isConnected };
    element.dataset.halaskaRoot = name;
    mounts.set(element, record);
    try { render(record); } catch (error) { unmount(element); throw error; }
  }
  element.dataset.halaskaRoot = name;
  return Object.freeze({ update: patch => update(element, patch), unmount: () => unmount(element), element });
}

function update(element, patch = {}) {
  const record = mounts.get(element);
  if (!record) throw new Error('HalaskaUI.update requires a mounted host');
  record.props = { ...record.props, ...patch };
  render(record);
}

function unmount(element) {
  const record = mounts.get(element);
  if (!record) return false;
  mounts.delete(element);
  flushSync(() => record.root.unmount());
  delete element.dataset.halaskaRoot;
  delete element.dataset.halaskaTheme;
  return true;
}

function prune() {
  for (const [element, record] of mounts) {
    if (element.isConnected) record.connected = true;
    else if (record.connected) unmount(element);
  }
}

let scheduled = false, theme = currentTheme();
const observer = new MutationObserver(records => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    prune();
    const next = currentTheme();
    if (next === theme) return;
    theme = next;
    for (const record of mounts.values()) render(record);
  });
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

// React-owned fixed labels respond to locale changes without remounting inputs.
document.addEventListener('workstation-language-change', () => { for (const record of mounts.values()) render(record); });

const api = Object.freeze({
  version: '1.0-aibro.1', mount, update, unmount, prune,
  node: value => valueNode(value), tokens, motion, usePal, React, ThemeProvider, AccentContext,
  componentNames: Object.freeze([...components.keys()]),
  register(name, implementation) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name) || typeof implementation !== 'function') throw new TypeError('A named, reviewed React component is required');
    if (components.has(name)) throw new Error(`HalaskaUI: ${name} is already registered`);
    components.set(name, implementation);
  },
  diagnostics: () => ({ mounts: mounts.size, theme: currentTheme() }),
});
window.HalaskaUI = api;
