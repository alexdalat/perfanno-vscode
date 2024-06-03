# perfanno-vscode

Perfanno-vscode is a simple extension that allows users to annotate buffers using perf output information. The result is a beatiful heatmap showing developers where performance bottlenecks are slowing down their program.

![Example](https://github.com/alexdalat/perfanno-vscode/blob/main/example.png?raw=true)

## Notes

* **Most of the code is taken directly from https://github.com/t-troebst/perfanno.nvim. I am not the original author of the code. I simply ported it to vscode/typescript and added a few features.**
* This extension is still in beta. It is not expansive in any way, but it does the job simply and effectively. If it gets any traction, I'll be sure to add more features.
* Only C++ programs on MacOS (with perf on Ubuntu) have been tested (by me). But anything that perf can profile should work.
* Please report any issues you may find.

---

## Workflow

1. Generate profiling information:

```bash
perf record --call-graph dwarf ./my_program --some-arg < some_input_etc
```
or alternatively, use the following alias by adding it to your `.bashrc` or `.zshrc`:
`alias perf_record="perf record --call-graph dwarf"`
and run:
`perf_record ./my_program --some-arg < some_input_etc`

Customization:
 * `-e` flag can be used to specify the event to profile. By default, it records cpu-cycles. See `perf list` for a list of events.
 * `-F` flag can be used to specify the frequency of the event. For example, `-F 1000` will sample every 1000 events.
 * And many more. See `man perf-record` for more information.

2. Generate a report:

```bash
perf report -g folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio -i perf.data > perf.out
```

again, you can use the following alias:

`alias perf_report="perf report -g folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio -i perf.data > perf.out"`
and run: 
`perf_report`

This command will always be the same. Therefore, if desired, one can chain both commands like so:
```bash
perf_record ./my_program --some-arg < some_input_etc && perf_report
```

3. (optional) If you are doing remote development and want to see the heatmap on your local machine (as I often do), you can use `scp` to copy the `perf.out` file to your local machine. Then, run `sed -i '' "s:{REMOTE_DIRECTORY}:{LOCAL_DIRECTORY}:g" "perf.out"` to replace any instances of the remote directory with the local directory in the perf report.

3. Open a source file in vscode and run the `perfanno.readFile` (`Perfanno: Read File`) command using the command palette. Select the `perf.out` file generated in the previous step. Profit.

---

## Extension Commands

* `perfanno.readFile`: Prompts for a file and annotates buffers with with the perf information.
* `perfanno.pickEvent`: Select a perf event to annotate.
* `perfanno.clearHighlights`: Clears all annotations and highlights.
* `perfanno.highlight`: Highlights the current line. Used to test certain highlighter capabilities.

## Extension Settings

* `perfanno.eventOutputType`: Specifies the output format for virtual text when annotating.
* `perfanno.localRelative`: Whether to show count relative to enclosing symbol (high sample count recommended).
* `perfanno.highlightColor`: The color of the highlight. 
* `perfanno.minimumThreshold`: The minimum percentage threshold for annotating.

---