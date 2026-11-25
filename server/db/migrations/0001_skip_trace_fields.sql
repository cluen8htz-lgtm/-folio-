ALTER TABLE "contacts" ADD COLUMN "is_litigator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "alt_phones" jsonb DEFAULT '[]'::jsonb NOT NULL;