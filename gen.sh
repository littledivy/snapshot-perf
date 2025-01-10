rm -f trace.txt events.txt

hyperfine --warmup 100 "../deno/target/release/deno empty.js"

../deno/target/release/deno --v8-flags=--trace-deserialization,--profile-deserialization,--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> trace.txt
../deno/target/release/deno --v8-flags=--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> events.txt

deno -A process.js
