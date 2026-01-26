import { SignIn } from "@/components/auth/SignIn";
import "./SignInPlayground.css";

export const SignInPlayground = () => {
  return (
    <div class="signin-playground" data-testid="signin-playground">
      <SignIn onSuccess={() => {}} />
    </div>
  );
};
