rm perf.* a.out

g++ -O2 -g -fno-omit-frame-pointer -fno-optimize-sibling-calls -Wall -Wextra main.cpp

SAMPLE_RATE=10000
MAX_SAMPLE_RATE=$(sysctl -n kernel.perf_event_max_sample_rate 2>/dev/null)
if [ -n "$MAX_SAMPLE_RATE" ] && [ "$MAX_SAMPLE_RATE" -lt "$SAMPLE_RATE" ]; then
	echo "Warning: kernel.perf_event_max_sample_rate ($MAX_SAMPLE_RATE) is below the requested sample rate ($SAMPLE_RATE)." >&2
	echo "perf will silently cap the rate, reducing sample coverage. To fix, run:" >&2
	echo "  sudo sysctl kernel.perf_event_max_sample_rate=$SAMPLE_RATE" >&2
fi

perf record -F "$SAMPLE_RATE" --call-graph dwarf ./a.out

perf report --call-graph folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio --stdio-color never --input perf.data > perf.out
