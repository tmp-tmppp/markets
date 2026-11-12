// Rule violations of the domain. They carry a stable code; the use cases decide what each one means for a caller.
export type DomainErrorCode =
  | "invalid_question"
  | "invalid_description"
  | "invalid_close_time"
  | "invalid_starting_price"
  | "invalid_funding_amount"
  | "invalid_outcome"
  | "invalid_tenant_id"
  | "invalid_sharing"
  | "invalid_share_link"
  | "invalid_transition";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
