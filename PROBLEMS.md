# KeepLocal — Active Problems & Issues Tracker

This document tracks all currently **unresolved** bugs, edge cases, and architectural issues in KeepLocal. As each issue is resolved, it is verified and removed from this list.

---

## Active Issues Summary

| Issue ID | Severity | Category | Status |
| :--- | :---: | :--- | :---: |
| **AUDIT-25** | Medium | Editor, Tabs & Line Numbers | Open |

---

## Active Issues Details

### 1. AUDIT-25: Dropped Tab Switching Clicks During In-Flight Tab Loading
- **Severity:** Medium
- **Location:** [`js/script.js#L3260`](file:///home/raja/Workspace/keepLocal/js/script.js#L3260) (`openTab`)
- **Root Cause:** When `isOpenTabInProgress` is true, clicking another tab immediately returns without queuing the target ID.
- **Impact:** Fast multi-tab switching causes tab clicks to be silently dropped, making the app feel unresponsive.
- **How to Fix:** Store `pendingOpenTabId = id;` when `isOpenTabInProgress` is active, and dispatch the pending switch in a `finally` block once the in-flight tab finishes loading.
- **Severity:** Medium
- **Location:** [`js/script.js#L3260`](file:///home/raja/Workspace/keepLocal/js/script.js#L3260) (`openTab`)
- **Root Cause:** When `isOpenTabInProgress` is true, clicking another tab immediately returns without queuing the target ID.
- **Impact:** Fast multi-tab switching causes tab clicks to be silently dropped, making the app feel unresponsive.
- **How to Fix:** Store `pendingOpenTabId = id;` when `isOpenTabInProgress` is active, and dispatch the pending switch in a `finally` block once the in-flight tab finishes loading.
