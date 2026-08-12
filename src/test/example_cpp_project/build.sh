g++ -O2 -g -fno-omit-frame-pointer -fno-optimize-sibling-calls -Wall -Wextra main.cpp

perf record --call-graph dwarf ./a.out

perf report --call-graph folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio --stdio-color never --input perf.data > perf.out
