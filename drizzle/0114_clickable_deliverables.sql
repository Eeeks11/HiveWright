ALTER TABLE "work_products" ADD COLUMN "title" text;
ALTER TABLE "work_products" ADD COLUMN "filename" text;
ALTER TABLE "work_products" ADD COLUMN "review_status" varchar(30) DEFAULT 'ready' NOT NULL;
ALTER TABLE "work_products" ADD COLUMN "render_mode" varchar(30);
ALTER TABLE "work_products" ADD COLUMN "public_url" text;
ALTER TABLE "work_products" ADD COLUMN "source_url" text;
ALTER TABLE "work_products" ADD COLUMN "published_at" timestamp DEFAULT now();
