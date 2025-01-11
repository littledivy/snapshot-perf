rm -f trace.txt events/events.*.txt

hyperfine --warmup 100 "../deno/target/release/deno empty.js"

../deno/target/release/deno --v8-flags=--trace-deserialization,--profile-deserialization,--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> trace.txt

n=100

for i in $(seq 0 $n); do
  ../deno/target/release/deno --v8-flags=--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> events/events.$i.txt
done

deno -A process.js $n
