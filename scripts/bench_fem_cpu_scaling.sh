#!/usr/bin/env bash
#
# bench_fem_cpu_scaling.sh — Measure FEM solver CPU scaling across thread counts.
#
# This script runs the FEM relaxation benchmark at multiple thread counts
# (4, 8, 20, 40) and multiple mesh resolutions to observe parallel scaling.
#
# Usage:
#   ./scripts/bench_fem_cpu_scaling.sh
#   ./scripts/bench_fem_cpu_scaling.sh --quick    # Fewer steps for fast check
#
# Output: Prints a summary table and writes detailed JSON to bench_results/
#
# Requirements:
#   - fullmag binary built and in PATH (or use `just build fullmag` first)
#   - Python with fullmag package available
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$REPO_ROOT/bench_results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# ── Configuration ───────────────────────────────────────────────────────

# Thread counts to test
THREAD_COUNTS=(4 8 20 40)

# Mesh resolutions (hmax in meters) — smaller = more nodes
# hmax=4e-9 → ~6-7k nodes, hmax=3e-9 → ~15k nodes, hmax=2.5e-9 → ~25k nodes
MESH_HMAX_VALUES=("4e-9" "3e-9" "2.5e-9")
MESH_LABELS=("coarse_4nm" "medium_3nm" "fine_2.5nm")

# Relaxation steps
MAX_STEPS=500

# Parse args
if [[ "${1:-}" == "--quick" ]]; then
    MAX_STEPS=100
    MESH_HMAX_VALUES=("4e-9" "3e-9")
    MESH_LABELS=("coarse_4nm" "medium_3nm")
    echo "[bench] Quick mode: $MAX_STEPS steps, ${#MESH_HMAX_VALUES[@]} mesh sizes"
fi

# ── Setup ───────────────────────────────────────────────────────────────

mkdir -p "$RESULTS_DIR"

# Ensure fullmag is available
if ! command -v fullmag &> /dev/null; then
    echo "[bench] ERROR: fullmag not found in PATH"
    echo "[bench] Run: just build fullmag"
    exit 1
fi

# Detect available CPU cores
AVAILABLE_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "unknown")
echo ""
echo "╔═══════════════════════════════════════════════════════════════════════╗"
echo "║              FEM CPU Scaling Benchmark - Fullmag                      ║"
echo "╠═══════════════════════════════════════════════════════════════════════╣"
echo "║ Available CPU cores: $AVAILABLE_CORES"
echo "║ Thread counts:       ${THREAD_COUNTS[*]}"
echo "║ Mesh sizes:          ${MESH_LABELS[*]}"
echo "║ Steps per run:       $MAX_STEPS"
echo "║ Results dir:         $RESULTS_DIR"
echo "╚═══════════════════════════════════════════════════════════════════════╝"
echo ""

# ── Run benchmarks ──────────────────────────────────────────────────────

RESULTS_JSON="$RESULTS_DIR/cpu_scaling_$TIMESTAMP.json"
echo "[" > "$RESULTS_JSON"
FIRST_RESULT=true

declare -A TIMING_DATA

for mesh_idx in "${!MESH_HMAX_VALUES[@]}"; do
    HMAX="${MESH_HMAX_VALUES[$mesh_idx]}"
    LABEL="${MESH_LABELS[$mesh_idx]}"
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " Mesh: $LABEL (hmax=$HMAX)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    for THREADS in "${THREAD_COUNTS[@]}"; do
        echo ""
        echo "[bench] Running with $THREADS threads..."
        
        RUN_LOG="$RESULTS_DIR/run_${LABEL}_${THREADS}t_$TIMESTAMP.log"
        
        # Time the full run
        START_TIME=$(date +%s.%N)
        
        FULLMAG_CPU_THREADS=$THREADS \
        BENCH_HMAX=$HMAX \
        BENCH_MAX_STEPS=$MAX_STEPS \
        fullmag --headless "$REPO_ROOT/examples/bench_fem_cpu_scaling.py" \
            2>&1 | tee "$RUN_LOG" || true
        
        END_TIME=$(date +%s.%N)
        ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)
        
        # Extract node count from log if available
        NODE_COUNT=$(grep -oP 'nodes:\s*\K\d+' "$RUN_LOG" 2>/dev/null || echo "unknown")
        
        # Extract step timing from log if available
        STEP_TIME_MS=$(grep -oP '\[\d+\.\d+ms\]' "$RUN_LOG" | tail -1 | tr -d '[]ms' || echo "unknown")
        
        echo "[bench] ✓ Completed: ${ELAPSED}s total (threads=$THREADS, mesh=$LABEL)"
        
        # Store for summary table
        TIMING_DATA["${LABEL}_${THREADS}"]="$ELAPSED"
        
        # Append to JSON
        if [ "$FIRST_RESULT" = true ]; then
            FIRST_RESULT=false
        else
            echo "," >> "$RESULTS_JSON"
        fi
        
        cat >> "$RESULTS_JSON" << EOF
  {
    "mesh_label": "$LABEL",
    "hmax_m": "$HMAX",
    "threads": $THREADS,
    "max_steps": $MAX_STEPS,
    "total_time_s": $ELAPSED,
    "node_count": "$NODE_COUNT",
    "timestamp": "$TIMESTAMP"
  }
EOF
    done
done

echo "" >> "$RESULTS_JSON"
echo "]" >> "$RESULTS_JSON"

# ── Summary table ───────────────────────────────────────────────────────

echo ""
echo ""
echo "╔═══════════════════════════════════════════════════════════════════════╗"
echo "║                         RESULTS SUMMARY                               ║"
echo "╠═══════════════════════════════════════════════════════════════════════╣"
echo ""
printf "%-15s" "Threads →"
for THREADS in "${THREAD_COUNTS[@]}"; do
    printf "%12s" "${THREADS}t"
done
echo ""
echo "─────────────────────────────────────────────────────────────────────────"

for mesh_idx in "${!MESH_LABELS[@]}"; do
    LABEL="${MESH_LABELS[$mesh_idx]}"
    printf "%-15s" "$LABEL"
    
    BASE_TIME=""
    for THREADS in "${THREAD_COUNTS[@]}"; do
        TIME="${TIMING_DATA[${LABEL}_${THREADS}]:-N/A}"
        if [ -z "$BASE_TIME" ] && [ "$TIME" != "N/A" ]; then
            BASE_TIME="$TIME"
        fi
        printf "%12s" "${TIME}s"
    done
    echo ""
done

echo ""
echo "─────────────────────────────────────────────────────────────────────────"
echo ""

# Calculate speedup relative to 4 threads
echo "Speedup (relative to 4 threads):"
printf "%-15s" "Threads →"
for THREADS in "${THREAD_COUNTS[@]}"; do
    printf "%12s" "${THREADS}t"
done
echo ""
echo "─────────────────────────────────────────────────────────────────────────"

for mesh_idx in "${!MESH_LABELS[@]}"; do
    LABEL="${MESH_LABELS[$mesh_idx]}"
    printf "%-15s" "$LABEL"
    
    BASE_TIME="${TIMING_DATA[${LABEL}_4]:-}"
    for THREADS in "${THREAD_COUNTS[@]}"; do
        TIME="${TIMING_DATA[${LABEL}_${THREADS}]:-}"
        if [ -n "$BASE_TIME" ] && [ -n "$TIME" ]; then
            SPEEDUP=$(echo "scale=2; $BASE_TIME / $TIME" | bc)
            printf "%12s" "${SPEEDUP}x"
        else
            printf "%12s" "N/A"
        fi
    done
    echo ""
done

echo ""
echo "╚═══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "[bench] Full results saved to: $RESULTS_JSON"
echo "[bench] Run logs saved to: $RESULTS_DIR/run_*.log"
echo ""
