rm -f trace.txt events/events.*.txt

# BIN_PATH=$(which node)
# BIN_PATH=../node/node
# BIN_PATH=$(which deno)
# BIN_PATH=./no_lazy_deno
# BIN_PATH=./wrap_deno
BIN_PATH=../deno/target/release/deno

hyperfine --warmup 100 "$BIN_PATH empty.js"

$BIN_PATH --v8-flags=--trace-deserialization,--profile-deserialization,--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> trace.txt

n=100

for i in $(seq 0 $n); do
  $BIN_PATH --v8-flags=--log-function-events,--no-logfile-per-isolate,--logfile=- empty.js >> events/events.$i.txt
done

deno -A process.js $n
