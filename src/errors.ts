export class TempLeaseError extends Error {
  override readonly name: string = "TempLeaseError";
}

export class TempLeaseRootError extends TempLeaseError {
  override readonly name = "TempLeaseRootError";
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

export class TempLeaseStateError extends TempLeaseError {
  override readonly name = "TempLeaseStateError";
}
