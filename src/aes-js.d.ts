declare module 'aes-js' {
  namespace ModeOfOperation {
    class ecb {
      constructor(key: Uint8Array);
      encrypt(data: Uint8Array): Uint8Array;
      decrypt(data: Uint8Array): Uint8Array;
    }
    class cbc {
      constructor(key: Uint8Array, iv: Uint8Array);
      encrypt(data: Uint8Array): Uint8Array;
      decrypt(data: Uint8Array): Uint8Array;
    }
  }
  namespace padding {
    function pkcs7pad(data: Uint8Array, blockSize: number): Uint8Array;
    function pkcs7unpad(data: Uint8Array): Uint8Array;
  }
}
