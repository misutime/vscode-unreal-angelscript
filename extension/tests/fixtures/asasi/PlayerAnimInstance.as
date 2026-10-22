// 准备角色的动画数据；动画蓝图读取这些值并生成骨骼姿势。
class UPanguAsasiPlayerAnimInstance : UAnimInstance
{
	config
	{
		// 水平速度超过此值时播放移动动画（cm/s）。
		float MoveAnimationSpeedThreshold = 0.01;
		// 随移动转向时限制混合空间方向的绝对值（度）。
		float MaxForwardDirection = 45.0;
	}

	state
	{
		AAsasiPlayerCharacter Character;
		UCharacterMovementComponent MovementComponent;

		// 实际速度（cm/s），保留垂直分量供空中状态判断。
		UPROPERTY(BlueprintReadOnly, Category = "Asasi|Animation")
		FVector Velocity;

		// 实际水平速度（cm/s）。
		UPROPERTY(BlueprintReadOnly, Category = "Asasi|Animation")
		float GroundSpeed = 0.0;

		// 移动方向相对角色朝向的角度（度）。
		UPROPERTY(BlueprintReadOnly, Category = "Asasi|Animation")
		float Direction = 0.0;

		UPROPERTY(BlueprintReadOnly, Category = "Asasi|Animation")
		bool ShouldMove = false;

		UPROPERTY(BlueprintReadOnly, Category = "Asasi|Animation")
		bool IsFalling = false;
	}
}

// 初始化与逐帧更新均由动画实例生命周期驱动，不依赖角色 Tick 的调用顺序。
impl UPanguAsasiPlayerAnimInstance
{
	UFUNCTION(BlueprintOverride)
	void BlueprintInitializeAnimation()
	{
		Character = Cast<AAsasiPlayerCharacter>(GetOwningActor());
		MovementComponent = IsValid(Character) ? Character.CharacterMovement : nullptr;
		UpdateAnimationValues();
	}

	UFUNCTION(BlueprintOverride)
	void BlueprintUpdateAnimation(float32 DeltaTimeX)
	{
		UpdateAnimationValues();
	}

	private void UpdateAnimationValues()
	{
		// 编辑器预览可能没有玩法角色；失去宿主时也不能保留上一帧的移动姿势。
		if (!IsValid(Character) || !IsValid(MovementComponent))
		{
			Velocity = FVector::ZeroVector;
			GroundSpeed = 0.0;
			Direction = 0.0;
			ShouldMove = false;
			IsFalling = false;
			return;
		}

		Velocity = MovementComponent.Velocity;
		GroundSpeed = Velocity.Size2D();
		ShouldMove = GroundSpeed > MoveAnimationSpeedThreshold;
		IsFalling = MovementComponent.IsFalling();
		Direction = CalculateDirection(Velocity, Character.ActorRotation);
		// 非横移角色转身时不切到完整后退动作，沿用移动组件的朝向模式。
		if (MovementComponent.bOrientRotationToMovement)
			Direction = Math::Clamp(Direction, -MaxForwardDirection, MaxForwardDirection);
	}
}
