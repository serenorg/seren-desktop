import { SignIn } from "@/components/auth/SignIn";

export const SignInPlayground = () => {
  return (
    <div
      class="min-h-screen flex items-center justify-center bg-[radial-gradient(circle_at_top,#121829,#040711)]"
      data-testid="signin-playground"
    >
      <SignIn onSuccess={() => {}} />
    </div>
  );
};
