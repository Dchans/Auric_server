export interface AuthAccount {
  id: string;
  email: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  role?: string;
  phoneNumber?: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined> & { authorization?: string };
  ip?: string;
  auricUser: AuthAccount;
};
