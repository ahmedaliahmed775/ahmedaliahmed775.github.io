# Atheer Research Suite Pro

Major update of the research demo environment for performance benchmarking and protocol verification workflows.

## What’s New (Major Update)

### 1) Live Demo (Default View)
- Interactive payment flow timeline that runs transaction steps in real-time.
- Step-by-step visualization of packet transit from merchant initialization to settlement ACK.
- Integrated with configurable network profile and stress levels.

### 2) Verification Module
- **Packet Integrity (JSON Live):** Generates and displays a live packet object with benchmark metadata, hash, and simulated digital signature fields.
- **AES-256 Proof:** Side-by-side display of original payload and AES-256 styled ciphertext representation for research presentation.

### 3) Sidebar & Config Enhancements
- Added **Live Demo** as the default navigation entry.
- Added **Config** control panel:
  - Network Profile toggle (`Private APN` / `Public Internet`)
  - Stress Level slider for simulation pressure.

### 4) Unified Benchmark Experience
- Benchmark chart is now synchronized with live simulation outputs.
- Latency and improvement indicators update in real-time based on the active network profile and stress configuration.

## Research Context
This implementation is designed to support research demonstrations aligned with IEEE-style technical reporting by combining:
- measurable benchmark indicators,
- protocol integrity visibility,
- and reproducible live simulation flow in a single interface.

## Files
- `index.html`: Full single-page application (UI + simulation + verification + chart).
- `CNAME`: Custom domain configuration.
