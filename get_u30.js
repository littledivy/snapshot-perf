function getUint30(data) {
  if (data.length < 4) {
    throw new Error("Insufficient data length");
  }

  let answer = data[0];
  answer |= data[1] << 8;
  answer |= data[2] << 16;
  answer |= data[3] << 24;

  const bytes = (answer & 3) + 1;

  if (data.length < bytes) {
    throw new Error("Data length less than required bytes");
  }

  let mask = 0xffffffff;
  mask >>>= 32 - (bytes << 3);
  answer &= mask;
  answer >>>= 2;

  return answer;
}

const ptrArr = new BigUint64Array([0x9444321011521401n, 0x5f706f00000017can, 0x6172745f6b61656cn, 0x7465675f676e6963n]);
const intArr = new Uint8Array(ptrArr.buffer);

console.log(getUint30(intArr)); // 380000000
