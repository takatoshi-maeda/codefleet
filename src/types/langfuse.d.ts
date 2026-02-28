declare module "langfuse" {
  export class Langfuse {
    constructor(options: {
      publicKey?: string;
      secretKey?: string;
      baseUrl?: string;
    });
  }

  export default Langfuse;
}
